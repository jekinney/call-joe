# Installs Chatterbox (free local voice cloning) into voice\.venv.
# Uses its own Python 3.11 and the NVIDIA (CUDA) build of PyTorch. Your main Python is not touched.
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $dir ".venv"

py -m uv --version 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Output "Installing uv (Python installer)..."
  py -m pip install --user --quiet uv
}
function uv { py -m uv @args; if ($LASTEXITCODE -ne 0) { throw "uv $($args[0]) failed" } }

Write-Output "Creating Python 3.11 environment..."
uv venv $venv --python 3.11 --allow-existing

Write-Output "Installing PyTorch with NVIDIA support (large download)..."
uv pip install --python $venv torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124

Write-Output "Installing Chatterbox..."
uv pip install --python $venv chatterbox-tts==0.1.7
# Chatterbox's watermark package still imports pkg_resources, which setuptools 81+ no longer ships.
uv pip install --python $venv "setuptools<81"

& "$venv\Scripts\python.exe" -c "import torch; print('CUDA available:', torch.cuda.is_available())"
Write-Output "Chatterbox is installed."
