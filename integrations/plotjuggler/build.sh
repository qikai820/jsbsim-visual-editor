#!/usr/bin/env bash
set -euo pipefail
integration_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
editor_dir=$(cd -- "$integration_dir/../.." && pwd)
source_dir="$editor_dir/.toolchains/PlotJuggler-3.16.0"
build_dir="$editor_dir/.toolchains/plotjuggler-build"
revision=5a0f01bcd5f8df7fd20923017b0dc3b72581337f
if [[ ! -d "$source_dir/.git" ]]; then
  git clone --depth 1 --branch 3.16.0 https://github.com/PlotJuggler/PlotJuggler.git "$source_dir"
fi
[[ $(git -C "$source_dir" rev-parse HEAD) == "$revision" ]] || { echo 'Unexpected PlotJuggler revision' >&2; exit 1; }
patch_file="$integration_dir/jsbsim-integration.patch"
if ! git -C "$source_dir" apply --reverse --check "$patch_file" 2>/dev/null; then
  git -C "$source_dir" apply --check "$patch_file"
  git -C "$source_dir" apply "$patch_file"
fi
extra_args=()
qt_x11_dir="$editor_dir/.toolchains/plotjuggler-deps/usr/lib/x86_64-linux-gnu/cmake/Qt5X11Extras"
if [[ -d "$qt_x11_dir" ]]; then extra_args+=("-DQt5X11Extras_DIR=$qt_x11_dir"); fi
cmake -S "$integration_dir" -B "$build_dir" -DPLOTJUGGLER_SOURCE="$source_dir" "${extra_args[@]}" -DCMAKE_BUILD_TYPE=Release -DCMAKE_DISABLE_FIND_PACKAGE_catkin=ON -DCMAKE_DISABLE_FIND_PACKAGE_ament_cmake=ON
cmake --build "$build_dir" --target plotjuggler JSBSimLive JSBSimMcap JSBSimMcapCheck PublisherCSV ToolboxFFT ToolboxLuaEditor ToolboxQuaternion -j "${PLOTJUGGLER_BUILD_JOBS:-8}"
if cmake --build "$build_dir" --target help | grep 'PublisherVideoViewer' >/dev/null; then
  cmake --build "$build_dir" --target PublisherVideoViewer -j "${PLOTJUGGLER_BUILD_JOBS:-8}"
fi
echo "PlotJuggler ready: $build_dir/bin/plotjuggler"
