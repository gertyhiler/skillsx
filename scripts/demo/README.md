# Reproduce the CLI demo

The recorder runs the real CLI against a disposable offline source and consumer.
It also reads a real symlink and makes a deliberate edit to demonstrate drift
detection. It never reads personal configuration or executes installed skills.
The fixture is removed even on failure. The JSON transcript contains complete
command output; the video uses a scrolling terminal viewport with edited timing.

```sh
node scripts/demo/record.mjs
uv run scripts/demo/render.py --sans /path/to/bold.ttf --mono /path/to/mono.ttf
```

Recording requires Node.js 22+. Rendering requires `uv`, `ffmpeg`, and two local
fonts. Pillow is pinned through the renderer's script metadata; none of these
tools is a SkillsX runtime dependency. Pass fonts available on your system.

Outputs live in `docs/assets`: `demo.json`, `demo.gif`, `demo.mp4`,
`demo-poster.png`, `hero.png`, and `social.png`. The small SVG logo is maintained
separately. Assets and demo scripts are covered by the repository's MIT license.
