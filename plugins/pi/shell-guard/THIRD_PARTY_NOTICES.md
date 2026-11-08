# Sources and implementation boundary

This plugin is maintained in gthubtom1/agent-plugins under MIT. It is an independent Pi package; it does not patch or redistribute Pi's core, Everything or ES.

Design references:

- Pi's documented extension events (`tool_call`, `input`, `before_agent_start`), settings API, command and tool registration: https://github.com/earendil-works/pi/tree/main/packages/coding-agent
- Pi's official `permission-gate.ts` and `timed-confirm.ts` examples illustrate pre-execution rejection and bounded user confirmation. Those interfaces are used here; the plugin's policy implementation is local code.
- Community timeout extensions discussed during research: https://github.com/cad0p/pi-bash-timeout , https://github.com/code-yeongyu/pi-bash-timeout , https://github.com/GhabiX/pi-timeout-policy . These are design references; their code is not bundled by this package. No blanket claim about their licenses, implementation equivalence or security is made.
- Everything CLI documentation: https://www.voidtools.com/support/everything/command_line_interface/ . The caller must separately provide the official local binary and index service.

The initial v0.1.0 tests/replay were limited and did not establish complete enforcement. The v0.2.0 review documents concrete fixes and unsupported surfaces; passing fixtures are not proof of isolation from arbitrary OS operations.
