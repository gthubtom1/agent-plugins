# Third-party sources

shell-guard's maintained code is local MIT code in gthubtom1/agent-plugins. The bundled unbash files retain their own ISC license. Pi core, Everything and ES are not bundled.

## Bundled code: unbash 3.0.0

- Source: [webpro-nl/unbash, commit 34e3f336b404fb7a6bd71ba8c9d0891fae005f6c](https://github.com/webpro-nl/unbash/tree/34e3f336b404fb7a6bd71ba8c9d0891fae005f6c).
- Published archive: <https://registry.npmjs.org/unbash/-/unbash-3.0.0.tgz>.
- Verified SHA-512: `sha512-FeFPZ/WFT0mbRCuydiZzpPFlrYN8ZUpphQKoq4EeElVIYjYyGzPMxQR/simUwCOJIyVhpFk4RbtyO7RuMpMnHA==`.
- ISC, Copyright (c) Lars Kappert. The six runtime JS files and exact license are copied unchanged into [src/vendor/unbash](src/vendor/unbash/README.md); that directory lists the actual import graph and file hashes. No build output was regenerated, and no runtime dependency or download is required.

## Design inspiration; no upstream source copied

- **pi-trash**, [Jinsung-L/pi-trash, commit cc1c8a7869c504299060ad326e27f9f098ad2806](https://github.com/Jinsung-L/pi-trash/tree/cc1c8a7869c504299060ad326e27f9f098ad2806): inspect the shell AST and rewrite Bash arguments to a Node helper that runs during actual execution. The release audit found MIT in package metadata, but no repository LICENSE file and no identified GitHub API license. That metadata is not treated as permission to copy substantive source; none is copied here. Local code keeps the existing single-target TEMP rename, strict flags and hard protections; parse failure blocks, with no original-rm fallback, multi-target handling, XDG storage or restore UI.
- **pi-bash-timeout**, [code-yeongyu/pi-bash-timeout, commit 876c0ce01a4ebcff118981f37b003db6c5ef6cb3](https://github.com/code-yeongyu/pi-bash-timeout/tree/876c0ce01a4ebcff118981f37b003db6c5ef6cb3): host Bash interception, default timeout injection and preserving valid explicit values. Upstream is MIT, Copyright (c) 2026 Yeongyu Kim. No source is copied here. Its `maxSeconds` is guidance; shell-guard's enforced ceiling and fast/default/heavy budgets are local requirements, not attributed to upstream.

## Host and external interfaces

- [Pi extension API and official permission-gate example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent): `tool_call` input mutation/blocking, `before_agent_start`, settings, command and tool registration. These documented interfaces are used by local code; no confirmation UI is registered.
- [Everything CLI documentation](https://www.voidtools.com/support/everything/command_line_interface/): the caller separately provides its executable and index service. Empty or limited index results do not establish file absence.

AST validation and command checks are a heuristic Bash guard, not an operating-system sandbox. Passing fixtures do not prove control over arbitrary scripts or other execution tools.
