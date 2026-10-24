// Gemini as a stand-in for Claude, used only when there's no Claude key (Settings -> Account). It answers the same
// calls the app makes to the Anthropic SDK (messages.create, beta.messages.create, beta.messages.stream), turning
// Claude-style requests into Gemini ones and Gemini's answers back, so calls, texts, voicemails, memory and the small
// helpers all work unchanged. Friends keep the same persona and memory notes; they may sound a little different.
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Claude's tiers, matched to Gemini's.
export const GEMINI_MODELS = { haiku: "gemini-3.5-flash-lite", sonnet: "gemini-3.8-flash", opus: "gemini-4-argon" };
// A Gemini model picked for a friend is used as it is; a Claude one gets its Gemini tier.
const geminiModel = (id = "") => (/^gemini-/.test(id) ? id : /haiku/.test(id) ? GEMINI_MODELS.haiku : /opus/.test(id) ? GEMINI_MODELS.opus : GEMINI_MODELS.sonnet);

const blocksOf = (content) => (typeof content === "string" ? [{ type: "text", text: content }] : content ?? []);

async function imagePart(source) {
  if (source.type === "base64") return { inlineData: { mimeType: source.media_type, data: source.data } };
  const r = await fetch(source.url, { signal: AbortSignal.timeout(10000) });
  const mime = r.headers.get("content-type")?.split(";")[0] || "image/gif";
  return { inlineData: { mimeType: mime, data: Buffer.from(await r.arrayBuffer()).toString("base64") } };
}

// Claude-style request -> Gemini request body.
async function toGemini(params, { search = true } = {}) {
  const names = {}; // tool_use id -> tool name, for the matching results
  const contents = [];
  for (const m of params.messages) {
    const parts = [];
    for (const b of blocksOf(m.content)) {
      if (b.type === "text" && b.text) parts.push({ text: b.text, ...(b._sig ? { thoughtSignature: b._sig } : {}) });
      else if (b.type === "image") parts.push(await imagePart(b.source));
      else if (b.type === "tool_use") {
        names[b.id] = b.name;
        parts.push({ functionCall: { name: b.name, args: b.input ?? {}, id: b.id }, ...(b._sig ? { thoughtSignature: b._sig } : {}) });
      } else if (b.type === "tool_result") {
        const text = typeof b.content === "string" ? b.content : blocksOf(b.content).filter((x) => x.type === "text").map((x) => x.text).join("\n");
        parts.push({ functionResponse: { name: names[b.tool_use_id] ?? "tool", id: b.tool_use_id, response: { content: text } } });
      }
      // Claude-only blocks (thinking, server tool results) have no Gemini equivalent and are left out.
    }
    if (!parts.length) continue;
    const role = m.role === "assistant" ? "model" : "user";
    if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts);
    else contents.push({ role, parts });
  }
  const system = typeof params.system === "string" ? params.system : blocksOf(params.system).map((b) => b.text).join("\n\n");
  const functions = (params.tools ?? []).filter((t) => t.input_schema).map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema }));
  const webSearch = search && (params.tools ?? []).some((t) => /^web_search/.test(t.type ?? ""));
  const tools = [...(functions.length ? [{ functionDeclarations: functions }] : []), ...(webSearch ? [{ googleSearch: {} }] : [])];
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    ...(tools.length ? { tools } : {}),
    // Room for Gemini's own thinking on top of the answer.
    generationConfig: { maxOutputTokens: Math.max(8000, params.max_tokens ?? 0) },
  };
}

// Gemini's answer (all chunks' parts) -> a Claude-style message.
function toClaude(parts, finish) {
  const content = [];
  let text = "", textSig;
  for (const p of parts) {
    if (p.thought) continue;
    if (p.text) { text += p.text; textSig ??= p.thoughtSignature; }
    if (p.functionCall) {
      content.push({
        type: "tool_use", id: p.functionCall.id || `call_${Math.random().toString(36).slice(2)}`,
        name: p.functionCall.name, input: p.functionCall.args ?? {}, ...(p.thoughtSignature ? { _sig: p.thoughtSignature } : {}),
      });
    }
  }
  if (text) content.unshift({ type: "text", text, ...(textSig ? { _sig: textSig } : {}) });
  const stop_reason = content.some((b) => b.type === "tool_use") ? "tool_use"
    : /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(finish ?? "") ? "refusal"
      : finish === "MAX_TOKENS" ? "max_tokens" : "end_turn";
  return { role: "assistant", content, stop_reason };
}

export function createGeminiClient(getKey) {
  const post = async (params, stream) => {
    const model = geminiModel(params.model);
    const url = `${BASE}/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    const send = async (search) => fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": getKey() },
      body: JSON.stringify(await toGemini(params, { search })),
    });
    let r = await send(true);
    // Some models won't mix Google Search with the friend's own tools; try again without search.
    if (r.status === 400 && (params.tools ?? []).some((t) => /^web_search/.test(t.type ?? ""))) r = await send(false);
    if (!r.ok) {
      const err = await r.json().catch(() => null);
      throw new Error(`Gemini (${model}) answered ${r.status}: ${String(err?.error?.message ?? "").slice(0, 200)}`);
    }
    return r;
  };

  async function create(params) {
    const j = await (await post(params, false)).json();
    const cand = j.candidates?.[0];
    if (!cand) return { role: "assistant", content: [], stop_reason: j.promptFeedback?.blockReason ? "refusal" : "end_turn" };
    return toClaude(cand.content?.parts ?? [], cand.finishReason);
  }

  // Streams text as Claude-style events; finalMessage() gives the whole message, with any tool calls.
  function stream(params) {
    const parts = [];
    let finish, resolveFinal, rejectFinal;
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
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            const cand = JSON.parse(line.slice(5)).candidates?.[0];
            if (!cand) continue;
            finish = cand.finishReason ?? finish;
            for (const p of cand.content?.parts ?? []) {
              parts.push(p);
              if (p.text && !p.thought) {
                if (!started) { started = true; yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }; }
                yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p.text } };
              }
            }
          }
        }
        resolveFinal(toClaude(parts, finish));
      } catch (err) {
        rejectFinal(err);
        throw err;
      }
    }
    const it = events();
    return { [Symbol.asyncIterator]: () => it, finalMessage: () => final };
  }

  const messages = { create, stream };
  return { gemini: true, messages, beta: { messages } };
}
