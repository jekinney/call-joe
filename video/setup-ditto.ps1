# Installs Ditto (realistic talking face from one picture) into video\.venv, with its code in video\ditto
# and model files in video\checkpoints. Uses its own Python 3.10 and the NVIDIA build of PyTorch.
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $dir ".venv"
$code = Join-Path $dir "ditto"
$ckpt = Join-Path $dir "checkpoints"

py -m uv --version 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { py -m pip install --user --quiet uv }
function uv { py -m uv @args; if ($LASTEXITCODE -ne 0) { throw "uv $($args[0]) failed" } }

if (-not (Test-Path $code)) {
  Write-Output "Downloading Ditto's code..."
  git clone --quiet --depth 1 https://github.com/antgroup/ditto-talkinghead $code
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
}

# Lets Ditto run without Microsoft's C++ compiler (see the comment in the patch file).
Copy-Item (Join-Path $dir "patches\blend_init.py") (Join-Path $code "core\utils\blend\__init__.py") -Force

Write-Output "Creating Python 3.10 environment..."
uv venv $venv --python 3.10 --allow-existing

Write-Output "Installing PyTorch with NVIDIA support (large download)..."
uv pip install --python $venv torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu121

Write-Output "Installing Ditto's other packages..."
uv pip install --python $venv librosa tqdm filetype imageio imageio-ffmpeg opencv-python-headless scikit-image cython colored "numpy==2.0.1" onnxruntime-gpu mediapipe huggingface_hub einops

Write-Output "Downloading Ditto's PyTorch model files (about 1 GB)..."
& "$venv\Scripts\python.exe" -c "from huggingface_hub import snapshot_download; snapshot_download('digital-avatar/ditto-talkinghead', local_dir=r'$ckpt', allow_patterns=['ditto_cfg/v0.4_hubert_cfg_pytorch.pkl', 'ditto_pytorch/*'])"
if ($LASTEXITCODE -ne 0) { throw "model download failed" }

& "$venv\Scripts\python.exe" -c "import torch; print('CUDA available:', torch.cuda.is_available())"
Write-Output "Ditto is installed."
