import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ModelRegistry,
  RegisteredCommand,
} from '@earendil-works/pi-coding-agent'
import type { RequestyStatusLoader } from '../../src/ui/requesty-status-loader'
import { DEFAULT_PROVIDER_ID } from '../../src/settings'

type RegisteredCommandOptions = Omit<RegisteredCommand, 'name' | 'sourceInfo'>
type UiCustom = ExtensionCommandContext['ui']['custom']
type UINotify = ExtensionCommandContext['ui']['notify']
type NotificationType = Parameters<UINotify>[1]
type UiCustomFactory = Parameters<UiCustom>[0]
type UiCustomFactoryArgs = Parameters<UiCustomFactory>
type UiCustomComponent = Awaited<ReturnType<UiCustomFactory>>
type UiCustomOptions = Parameters<UiCustom>[1]
type FakeUiCustomFactory<T> = (
  tui: UiCustomFactoryArgs[0],
  theme: UiCustomFactoryArgs[1],
  keybindings: UiCustomFactoryArgs[2],
  done: (result: T) => void,
) => UiCustomComponent | Promise<UiCustomComponent>

export type CapturedEventHandler = (...args: unknown[]) => unknown

export function createFakePi() {
  const commands = new Map<string, RegisteredCommandOptions>()
  const eventHandlers = new Map<string, CapturedEventHandler>()

  const on: ExtensionAPI['on'] = (event, handler) => {
    eventHandlers.set(event, handler as CapturedEventHandler)
  }

  const pi = {
    registerCommand(name: string, command: RegisteredCommandOptions) {
      commands.set(name, command)
    },
    on,
  } as unknown as ExtensionAPI

  return { pi, commands, eventHandlers }
}

type RefreshOptions = Parameters<ModelRegistry['refresh']>[0]
type RefreshResult = Awaited<ReturnType<ModelRegistry['refresh']>>

type FakeCommandContextOptions = {
  mode?: ExtensionCommandContext['mode']
  /** Value returned by ctx.ui.confirm. Defaults to true so existing write paths keep working. */
  confirmResult?: boolean
  /** Provider id of the currently selected model (ctx.model.provider). Defaults to the configured Requesty provider id. */
  modelProvider?: string
  /** Whether a UI/footer is available (ctx.hasUI). Defaults to true; set false for print/json mode. */
  hasUI?: boolean
  knownApiKeys?: Record<string, string>
  refreshResult?: RefreshResult
}

export function createFakeCommandContext(options: FakeCommandContextOptions = {}) {
  const capturedNotifications: Array<{ message: string; type?: NotificationType }> = []
  const capturedStatuses: string[] = []
  const capturedStatusLines: Array<{ key: string; text: string | undefined }> = []
  const capturedConfirmations: Array<{ title: string; message: string }> = []
  const confirmResult = options.confirmResult ?? true

  const fakeTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  } as unknown as UiCustomFactoryArgs[1]

  // noinspection JSUnusedGlobalSymbols - requestRender is required by the ui component
  const fakeTui = {
    requestRender() {
      // Tests only assert message plumbing, not TUI rendering.
    },
  } as unknown as UiCustomFactoryArgs[0]

  const fakeKeybindings = null as unknown as UiCustomFactoryArgs[2]

  const custom: UiCustom = <T>(factory: FakeUiCustomFactory<T>, options?: UiCustomOptions): Promise<T> => {
    void options
    return new Promise<T>(resolve => {
      const loader = factory(fakeTui, fakeTheme, fakeKeybindings, result => {
        loader.dispose()
        resolve(result)
      }) as unknown as RequestyStatusLoader

      const originalSetMessage = loader.setMessage.bind(loader)
      loader.setMessage = (message: string) => {
        capturedStatuses.push(message)
        originalSetMessage(message)
      }
    })
  }

  const capturedUiOrder: ('notify' | 'confirm')[] = []
  const modelProvider = options.modelProvider ?? DEFAULT_PROVIDER_ID
  const capturedModelRefreshes: RefreshOptions[] = []

  /**
   * The extension fires off the usage-status update without awaiting it, so tests must await the
   * observable effect: the status line writes. Drains microtasks until `expected` writes happened
   * and fails fast instead of hanging if they never do.
   */
  const waitForStatusLines = async (expected: number, maxRounds = 100): Promise<void> => {
    for (let drained = 0; capturedStatusLines.length < expected && drained < maxRounds; drained++) {
      await Promise.resolve()
    }
    if (capturedStatusLines.length < expected) {
      throw new Error(
        `Timed out waiting for ${expected} status line write(s) after ${maxRounds} microtask rounds; ` +
          `captured ${JSON.stringify(capturedStatusLines)}`,
      )
    }
  }
  const modelRegistry = {
    getApiKeyForProvider: (providerId: string) => Promise.resolve((options.knownApiKeys ?? {})[providerId]),
    refresh: (param: RefreshOptions) => {
      capturedModelRefreshes.push(param)
      return Promise.resolve(
        options.refreshResult ?? { aborted: false, errors: new Map() },
      ) satisfies Promise<RefreshResult>
    },
  } as unknown as ModelRegistry

  const ctx = {
    mode: options.mode ?? 'tui',
    hasUI: options.hasUI ?? true,
    model: { provider: modelProvider },
    ui: {
      notify(message: string, type?: NotificationType) {
        capturedNotifications.push({ message, type })
        capturedUiOrder.push('notify')
      },
      confirm(title: string, message: string) {
        capturedConfirmations.push({ title, message })
        capturedUiOrder.push('confirm')
        return Promise.resolve(confirmResult)
      },
      custom,
      setStatus(key: string, text: string | undefined) {
        capturedStatusLines.push({ key, text })
      },
    },
    modelRegistry,
  } as unknown as ExtensionCommandContext

  return {
    ctx,
    capturedNotifications,
    capturedStatuses,
    capturedStatusLines,
    capturedConfirmations,
    capturedUiOrder,
    capturedModelRefreshes,
    waitForStatusLines,
  }
}

export async function fireEvent(
  eventHandlers: Map<string, (...args: unknown[]) => unknown>,
  eventName: string,
  ctx: ReturnType<typeof createFakeCommandContext>['ctx'],
) {
  const handler = eventHandlers.get(eventName)
  if (!handler) throw new Error(`${eventName} handler was not registered`)
  // none of the handlers is actually consuming this. so there is no sense to actually pass any real value
  const unusedEvent = {}
  await handler(unusedEvent, ctx)
}
