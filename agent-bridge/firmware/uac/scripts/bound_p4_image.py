"""Write and verify ESP32-P4 chip revision bounds into generated images."""

Import("env")

import re
from pathlib import Path


def _bounds(project: Path, build_env) -> tuple[int, int]:
    config_path = project / ("sdkconfig." + build_env.subst("$PIOENV"))
    config = config_path.read_text(encoding="utf-8")
    values = tuple(
        int(re.search(r"^CONFIG_ESP_REV_" + key + r"_FULL=(\d+)$", config, re.M)[1])
        for key in ("MIN", "MAX")
    )
    expected = (300, 399)
    if not (expected[0] <= values[0] <= values[1] <= expected[1]):
        raise RuntimeError(
            f"V3 proof requires chip bounds inside {expected}, found {values}; "
            "regenerate the V3 sdkconfig"
        )
    return values


def _rewrite_image(source, target, env):
    project = Path(env.subst("$PROJECT_DIR"))
    minimum, maximum = _bounds(project, env)
    output = Path(str(target[0]))
    elf = output.with_suffix(".elf")
    app_flags = " --elf-sha256-offset 0xb0" if output.name == "firmware.bin" else ""
    command = (
        "$ERASETOOL --chip esp32p4 elf2image"
        " --flash-mode ${__get_board_flash_mode(__env__)}"
        " --flash-freq ${__get_board_f_image(__env__)} --flash-size 32MB"
        f" --min-rev-full {minimum} --max-rev-full {maximum}"
        f'{app_flags} -o "{output}" "{elf}"'
    )
    if env.Execute(command):
        raise RuntimeError("failed to regenerate revision-bounded P4 image")

    header = output.read_bytes()[:24]
    actual = (
        int.from_bytes(header[15:17], "little"),
        int.from_bytes(header[17:19], "little"),
    ) if len(header) == 24 else None
    if header[:1] != b"\xe9" or int.from_bytes(header[12:14], "little") != 18:
        raise RuntimeError(f"invalid P4 image header after rebuild: {output}")
    if actual != (minimum, maximum):
        raise RuntimeError(
            f"P4 image bounds verification failed for {output}: {actual} "
            f"!= {(minimum, maximum)}"
        )

    if output.name == "firmware.bin":
        merged = output.with_name("firmware.factory.bin")
        merge_command = (
            "$ERASETOOL --chip esp32p4 merge-bin --flash-mode dio "
            "--flash-freq 80m --flash-size 32MB "
            f'-o "{merged}" '
            f'0x2000 "{output.parent / "bootloader.bin"}" '
            f'0x8000 "{output.parent / "partitions.bin"}" '
            f'0x10000 "{output}"'
        )
        if env.Execute(merge_command):
            raise RuntimeError("failed to merge revision-bounded P4 factory image")


env.AddPostAction("$BUILD_DIR/bootloader.bin", _rewrite_image)
env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", _rewrite_image)
