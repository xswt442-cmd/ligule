// The kernel's tool table starts empty: a freshly constructed kernel provides
// no capability at all (I1). Everything it can do arrives through register().
//
// Nothing in this file may import a transport, a UI framework or an adapter.
// CLI and desktop are adapters over this same object; adding one must not
// change a line in here.

export class KernelError extends Error {
  constructor(code) {
    super(code)
    this.name = 'KernelError'
    this.code = code
  }
}

export function createKernel() {
  const tools = new Map()

  return {
    // What a run has installed is readable from one place (I2).
    list() {
      return [...tools.keys()].sort()
    },

    // Registering returns the dispose action. A duplicate name is an error,
    // never a silent drop: half panic and half discard is the failure mode
    // this rule exists to prevent.
    register(tool) {
      if (!tool || typeof tool.name !== 'string' || tool.name === '') {
        throw new KernelError('tool_name_required')
      }
      if (typeof tool.run !== 'function') {
        throw new KernelError('tool_run_required')
      }
      if (tools.has(tool.name)) {
        throw new KernelError('tool_already_registered')
      }
      tools.set(tool.name, tool)
      return () => {
        tools.delete(tool.name)
      }
    },

    // Every failure carries a stable code the caller branches on (I9).
    async call(name, args) {
      const tool = tools.get(name)
      if (!tool) throw new KernelError('tool_not_found')
      return tool.run(args)
    },
  }
}
