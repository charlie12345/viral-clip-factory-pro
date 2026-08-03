param(
    [ValidateSet("auto", "amd-gfx1151", "cuda", "cpu")]
    [string]$TorchProfile = "auto",
    [string]$PythonVersion = "3.12",
    [string]$TorchVersion = "2.11.0"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw "uv is required: https://docs.astral.sh/uv/" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "Node.js 20-22 and npm are required." }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { throw "FFmpeg with AMF support is required on PATH." }

uv python install $PythonVersion
uv venv --python $PythonVersion venv
$Python = Join-Path $Root "venv\Scripts\python.exe"

if ($TorchProfile -eq "auto") {
    $VideoControllers = Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name
    if ($VideoControllers -match "AMD|Radeon") { $TorchProfile = "amd-gfx1151" }
    elseif ($VideoControllers -match "NVIDIA") { $TorchProfile = "cuda" }
    else { $TorchProfile = "cpu" }
}

switch ($TorchProfile) {
    "amd-gfx1151" {
        uv pip install --python $Python --index-url https://repo.amd.com/rocm/whl/gfx1151/ "torch==$TorchVersion+rocm7.13.0" "torchvision==0.26.0+rocm7.13.0" "torchaudio==$TorchVersion+rocm7.13.0"
    }
    "cuda" {
        $CudaIndex = if ($env:VCF_CUDA_INDEX_URL) { $env:VCF_CUDA_INDEX_URL } else { "https://download.pytorch.org/whl/cu130" }
        uv pip install --python $Python --index-url $CudaIndex "torch==$TorchVersion" "torchvision==0.26.0" "torchaudio==$TorchVersion"
    }
    "cpu" {
        uv pip install --python $Python --index-url https://download.pytorch.org/whl/cpu "torch==$TorchVersion" "torchvision==0.26.0" "torchaudio==$TorchVersion"
    }
}

uv pip install --python $Python --no-deps -r requirements.lock.txt
npm ci
npm --prefix webui ci
npm run build
& $Python scripts\doctor.py
