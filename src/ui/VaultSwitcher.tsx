/**
 * The vault switcher: the app's own name in the sidebar, replaced by the name
 * of the vault you are in.
 *
 * It goes here rather than in a bar of its own because a vault is simply the
 * outermost scope, and the sidebar is already the column that answers "what am
 * I looking at" — vault, then folder, then tag. The head of that column was
 * showing the word "Slate", which is the one thing on screen nobody needed
 * told; a vault-based app should say which vault, the way Obsidian's title bar
 * does and the way the app icon never will.
 *
 * With one vault it is exactly what it was, plus a chevron: the name, quietly,
 * and no colour — a coloured dot beside "Slate" would be an identifier for a
 * set of one. The dot appears when there is something to tell apart.
 */

import { IconChevron, IconPlus, IconSettings } from './Icons'
import { openMenu, type MenuItem } from './Menu'
import { openPrompt } from './PromptDialog'
import { openSettings } from './state'
import {
  activeVault,
  activeVaultId,
  createVault,
  switchToVault,
  vaults,
  VAULT_COLOURS,
} from '../core/vaults'

/**
 * The colour a new vault gets.
 *
 * The first one nobody is using, so two vaults made in a row are never the same
 * colour — which is the entire job the colour has. Once they are all spoken for
 * it wraps, because eight vaults is well past the point where the colour was
 * doing the work and the name is.
 */
export function nextColour(): string {
  const taken = new Set(vaults.value.map((v) => v.colour))
  return VAULT_COLOURS.find((c) => !taken.has(c)) ?? VAULT_COLOURS[vaults.value.length % VAULT_COLOURS.length]
}

export function promptForNewVault(): void {
  openPrompt({
    title: 'New vault',
    label: 'Name',
    value: '',
    placeholder: 'Work',
    hint: 'A separate set of notes with its own sync, its own folder and its own settings. Nothing is shared with the vault you are in now — including search, tags and links.',
    confirm: 'Create and open',
    onSubmit: async (name) => {
      const rec = await createVault(name, nextColour())
      await switchToVault(rec.id)
    },
  })
}

export function openVaultMenu(e: { clientX: number; clientY: number }): void {
  const items: MenuItem[] = vaults.value.map((v) => ({
    label: v.name,
    checked: v.id === activeVaultId.value,
    icon: <span class="vault-dot" style={{ background: v.colour }} />,
    onSelect: () => void switchToVault(v.id),
  }))
  items.push({
    label: 'New vault…',
    icon: <IconPlus size={13} />,
    separated: true,
    onSelect: promptForNewVault,
  })
  items.push({
    label: 'Manage vaults…',
    icon: <IconSettings size={13} />,
    onSelect: () => openSettings('vaults'),
  })
  openMenu(e, items, vaults.value.length > 1 ? 'Vaults' : undefined)
}

export function VaultSwitcher() {
  const list = vaults.value
  const cur = activeVault()
  return (
    <button
      class="vault-switch"
      onClick={(e) => openVaultMenu(e as unknown as MouseEvent)}
      title={list.length > 1 ? `${cur?.name ?? 'Slate'} — switch vault` : 'Vaults'}
    >
      {list.length > 1 && <span class="vault-dot" style={{ background: cur?.colour }} />}
      <span class="vault-name">{cur?.name ?? 'Slate'}</span>
      <IconChevron size={11} />
    </button>
  )
}
