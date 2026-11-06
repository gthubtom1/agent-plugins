# Sources and implementation boundary

This package's implementation is maintained in gthubtom1/agent-plugins under MIT. Pi itself and the agent's existing project artifacts retain their original licenses.

Design references (not runtime dependencies, not co-installed packages):

- Joseph Kern, josephkern/pi-memory, MIT; examined commit 312627ffc5a47de690b3066276009e7d651f8729: https://github.com/josephkern/pi-memory/tree/312627ffc5a47de690b3066276009e7d651f8729 . Project-local Markdown index, bounded prompt context and on-demand topic lookup informed this design.
- Ahmad Othman Ammar Adi and contributors, OthmanAdi/planning-with-files, MIT; examined commit 8eef6dc6540dde5eef3fdc0ac487ad9c48ef3ba5: https://github.com/OthmanAdi/planning-with-files/tree/8eef6dc6540dde5eef3fdc0ac487ad9c48ef3ba5/.pi/skills/planning-with-files . Lifecycle-aware project handoff informed the design; its task-plan system, execution approvals and continuation gates are not included.
- Earendil Works and contributors, Pi coding-agent docs and extension examples, MIT: https://github.com/earendil-works/pi . The public ExtensionAPI supplies lifecycle and tool registration. Host modules are peers and are not bundled here.

No upstream memory extension source is vendored into this package. The file store and adapter are implemented against our project-local source/revision requirements. Do not claim upstream vendors endorse this package or that upstream memory benchmarks validate it.
