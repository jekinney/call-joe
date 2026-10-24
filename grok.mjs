// Grok (xAI) as a brain a friend can think with: picked in their Brain list, or switched to automatically when their
// flirting is set to Rated R. Like gemini.mjs, it answers the same calls the app makes to the Anthropic SDK
// (messages.create, beta.messages.create, beta.messages.stream), turning Claude-style requests into xAI's
// OpenAI-style chat completions and the answers back. Friends keep the same persona and memory notes.
const BASE = "https://api.x.ai/v1";

const blocksOf = (content) => (typeof content === "string" ? [{ type: "text", text: content }] : content ?? []);
const imagePart = (source) => ({
  type: "image_url",
  image_url: { url: source.type === "base64" ? `data:${source.media_type};base64,${source.data}` : source.url },
});

// Claude-style request -> chat completions body.
function toGrok(params, model, stream) {
  const messages = [];
  const system = typeof params.system === "string" ? params.system : blocksOf(params.system).map((b) => b.text).join("\n\n");
  if (system) messages.push({ role: "system", content: system });
  for (const m of params.messages) {
    const blocks = blocksOf(m.content);
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const calls = blocks.filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (text || calls.length) messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results go first, as their own messages, right after the assistant's tool calls.
    for (const b of blocks.filter((x) => x.type === "tool_result")) {
      const text = typeof b.content === "string" ? b.content : blocksOf(b.content).filter((x) => x.type === "text").map((x) => x.text).join("\n");
      messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: text || "(no result)" });
    }
    const parts = blocks.flatMap((b) => (b.type === "text" && b.text ? [{ type: "text", text: b.text }] : b.type === "image" ? [imagePart(b.source)] : []));
    if (parts.length) messages.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("\n\n") : parts });
  }
  // Only the friend's own tools; Claude's server tools (web search) have no equivalent here and are left out.
  const tools = (params.tools ?? []).filter((t) => t.input_schema)
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  return {
    model, messages, max_tokens: Math.max(1024, params.max_tokens ?? 0),
    ...(tools.length ? { tools } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

const stopReason = (finish, calls) => (calls ? "tool_use" : finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : "end_turn");

// getKey: the saved xAI key. pickModel: turns the model asked for into a Grok model id.
export function createGrokClient(getKey, pickModel) {
  const post = async (params, stream) => {
    const model = pickModel(params.model);
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getKey()}` },
      body: JSON.stringify(toGrok(params, model, stream)),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => null);
      throw new Error(`Grok (${model}) answered ${r.status}: ${String(err?.error?.message ?? err?.error ?? err?.message ?? "").slice(0, 200)}`);
    }
    return r;
  };

  async function create(params) {
    const j = await (await post(params, false)).json();
    const choice = j.choices?.[0];
    const msg = choice?.message ?? {};
    const content = [];
    if (msg.content) content.push({ type: "text", text: msg.content });
    for (const t of msg.tool_calls ?? []) {
      let input = {};
      try { input = JSON.parse(t.function?.arguments || "{}"); } catch {}
      content.push({ type: "tool_use", id: t.id, name: t.function?.name, input });
    }
    return { role: "assistant", content, stop_reason: msg.refusal ? "refusal" : stopReason(choice?.finish_reason, (msg.tool_calls ?? []).length) };
  }

  // Streams text as Claude-style events; finalMessage() gives the whole message, with any tool calls.
  function stream(params) {
    let text = "", finish;
    const calls = []; // by index: { id, name, args }
    let resolveFinal, rejectFinal;
    const final = new Promise((res, rej) => { resolveFinal = res; rejectFinal = rej; });
    final.catch(() => {});
    async function* events() {
      try {
        const r = await post(params, true);
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "", started = false;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            const choice = JSON.parse(data).choices?.[0];
            if (!choice) continue;
            finish = choice.finish_reason ?? finish;
            const d = choice.delta ?? {};
            for (const t of d.tool_calls ?? []) {
              const c = (calls[t.index ?? 0] ??= { id: "", name: "", args: "" });
              if (t.id) c.id = t.id;
              if (t.function?.name) c.name += t.function.name;
              if (t.function?.arguments) c.args += t.function.arguments;
            }
            if (d.content) {
              text += d.content;
              if (!started) { started = true; yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }; }
              yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: d.content } };
            }
          }
        }
        const content = text ? [{ type: "text", text }] : [];
        for (const c of calls.filter(Boolean)) {
          let input = {};
          try { input = JSON.parse(c.args || "{}"); } catch {}
          content.push({ type: "tool_use", id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.name, input });
        }
        resolveFinal({ role: "assistant", content, stop_reason: stopReason(finish, calls.filter(Boolean).length) });
      } catch (err) {
        rejectFinal(err);
        throw err;
      }
    }
    const it = events();
    return { [Symbol.asyncIterator]: () => it, finalMessage: () => final };
  }

  const messages = { create, stream };
  return { grok: true, messages, beta: { messages } };
}

// The Grok models for chat, newest first: { main, fast }. ids: every model the key can use.
export function pickGrokModels(ids) {
  const version = (id) => Number(id.match(/^grok-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const chat = [...ids].filter((id) => /^grok-\d/.test(id) && !/image|imagine|vision|voice|video|code|embed|tts|audio/.test(id))
    .sort((a, b) => version(b) - version(a) || a.length - b.length);
  const main = chat.find((id) => !/fast|mini/.test(id)) ?? chat[0] ?? null;
  // For calls, a fast model that doesn't stop to reason answers quickest.
  const fast = chat.find((id) => /fast/.test(id) && /non-reasoning/.test(id)) ?? chat.find((id) => /fast|mini/.test(id)) ?? main;
  return { main, fast };
}
