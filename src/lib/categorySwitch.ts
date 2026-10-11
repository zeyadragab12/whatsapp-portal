import type { TButton } from './types'

export interface SwitchContent { header: string; body: string; footer: string; buttons: TButton[]; hasMedia: boolean }

/**
 * What switching to another category would hide. Only Authentication drops content, because Meta fixes its format.
 * When something would be set aside the person is asked first, and the editor keeps it so switching back restores it.
 * Utility and Marketing share the same components, so moving between them never loses anything (it only changes the warnings).
 */
export function planCategorySwitch(from: string, to: string, c: SwitchContent): { needsConfirm: boolean; setAside: string[]; restore: boolean } {
  if (from === to) return { needsConfirm: false, setAside: [], restore: false }
  if (to === 'AUTHENTICATION') {
    const setAside: string[] = []
    if (c.body.trim()) setAside.push('the message text')
    if (c.header.trim()) setAside.push('the header')
    if (c.hasMedia) setAside.push('the image or video')
    if (c.footer.trim()) setAside.push('the footer')
    if (c.buttons.length) setAside.push('the buttons')
    return { needsConfirm: setAside.length > 0, setAside, restore: false }
  }
  return { needsConfirm: false, setAside: [], restore: from === 'AUTHENTICATION' }
}
