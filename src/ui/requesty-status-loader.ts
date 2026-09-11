import { DynamicBorder, Theme } from '@earendil-works/pi-coding-agent'
import { Container, Loader, Spacer, type TUI } from '@earendil-works/pi-tui'

/**
 * A loader that allows us to change the displayed message.
 *
 * @remarks
 * this is essentially a reimplementation of the default BorderedLoader from pi-tui
 * which does not offer a public api for changing its message.
 */
export class RequestyStatusLoader extends Container {
  private readonly loader: Loader

  constructor(tui: TUI, theme: Theme, message: string) {
    super()

    const borderColor = (s: string) => theme.fg('border', s)
    this.loader = new Loader(
      tui,
      s => theme.fg('accent', s),
      s => theme.fg('muted', s),
      message,
    )

    this.addChild(new DynamicBorder(borderColor))
    this.addChild(this.loader)
    this.addChild(new Spacer(1))
    this.addChild(new DynamicBorder(borderColor))
  }

  setMessage(message: string): void {
    this.loader.setMessage(message)
  }

  dispose(): void {
    this.loader.stop()
  }
}
