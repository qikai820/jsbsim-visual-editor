#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/dist/windows"

echo "=== JSBSim Visual Editor — Windows Cross-Compile ==="

# Check prerequisites
echo "[1/4] Checking prerequisites..."
if ! command -v x86_64-w64-mingw32-gcc &> /dev/null; then
    echo "Error: mingw-w64 not found. Install with: sudo apt install gcc-mingw-w64-x86-64"
    exit 1
fi

if ! rustup target list --installed | grep -q "x86_64-pc-windows-gnu"; then
    echo "Adding Windows Rust target..."
    rustup target add x86_64-pc-windows-gnu
fi

# Ensure Cargo config exists
if [ ! -f ~/.cargo/config.toml ] || ! grep -q "x86_64-pc-windows-gnu" ~/.cargo/config.toml; then
    echo "Configuring Cargo linker..."
    mkdir -p ~/.cargo
    cat > ~/.cargo/config.toml << 'EOF'
[target.x86_64-pc-windows-gnu]
linker = "x86_64-w64-mingw32-gcc"
EOF
fi

# Build frontend
echo "[2/4] Building frontend..."
cd "$SCRIPT_DIR"
npm run build

# Build Rust for Windows
echo "[3/4] Cross-compiling Rust for Windows..."
cd src-tauri
# Bake Windows-style JSBSim paths into the binary so the .exe has correct
# defaults on the target machine (override at runtime via env vars if needed).
export JSBSIM_ROOT='C:\jsbsim'
export JSBSIM_BIN='C:\jsbsim\build\src\JSBSim.exe'
cargo build --release --target x86_64-pc-windows-gnu

# Copy output
echo "[4/4] Copying executable..."
mkdir -p "$OUTPUT_DIR"
cp target/x86_64-pc-windows-gnu/release/jsbsim-visual-editor.exe "$OUTPUT_DIR/"

echo ""
echo "=== Build Complete ==="
echo "Output: $OUTPUT_DIR/jsbsim-visual-editor.exe"
echo "Size: $(du -h "$OUTPUT_DIR/jsbsim-visual-editor.exe" | cut -f1)"
echo ""
echo "Note: Windows 10+ includes WebView2 Runtime required by Tauri."
echo "If the .exe fails to start, install WebView2 from:"
echo "  https://developer.microsoft.com/en-us/microsoft-edge/webview2/"
