/**
 * Settings → Vaults: the list, and the three things you can do to one.
 *
 * Deliberately thin. Making a vault is a name; the rest of setting it up is
 * every other tab in this dialog, done inside that vault, because a vault's
 * backend and folder and model connection are not settings *about* vaults —
 * they are that vault's own settings, and offering them from here would mean
 * editing one vault's credentials while looking at another's notes.
 *
 * So what is here is what genuinely belongs to the set: what each one is
 * called, what colour it is, whether two of them have been pointed at the same
 * place, and how to be rid of one.
 */

import { settings } from '../core/settings'
import {
  activeVaultId,
  recolourVault,
  removeVault,
  renameVault,
  switchToVault,
  urlForVault,
  vaults,
  vaultsSharingTargets,
  VAULT_COLOURS,
  type VaultRecord,
} from '../core/vaults'
import { promptForNewVault } from './VaultSwitcher'
import { openPrompt } from './PromptDialog'
import { notify } from './state'
import { IconPlus, IconWarn } from './Icons'

export function VaultsCard() {
  const list = vaults.value
  const clashes = vaultsSharingTargets()

  const rename = (v: VaultRecord) =>
    openPrompt({
      title: 'Rename vault',
      label: 'Name',
      value: v.name,
      confirm: 'Rename',
      onSubmit: (name) => renameVault(v.id, name),
    })

  /**
   * Removing a vault, with the asymmetry said out loud.
   *
   * The browser's own `confirm()` rather than the app's dialog, which is the
   * rule the other irreversible actions here follow: this is the one action in
   * the feature that destroys something, and an alert nobody can dismiss by
   * accident is exactly what belongs in front of it.
   */
  const remove = async (v: VaultRecord) => {
    const where = v.targets?.length
      ? `Its notes are also on ${v.targets.join(' and ')}, so a new vault pointed at the same place would get them back.`
      : `This vault has no backend and no connected folder, so this device is the only place its notes exist. They cannot be got back.`
    if (
      !confirm(
        `Remove the vault “${v.name}” from this device?\n\n${where}\n\nNothing on a server, in a Drive folder or in a connected folder is deleted — only this device's copy.`,
      )
    )
      return
    const next = await removeVault(v.id)
    if (!next) {
      notify('That is the only vault, so there is nowhere to go afterwards.', 'error')
      return
    }
    if (v.id === activeVaultId.value) await switchToVault(next)
    else notify(`“${v.name}” removed from this device.`)
  }

  return (
    <>
      {clashes.map((clash) => (
        <div class="callout callout-danger" key={clash.target}>
          <IconWarn size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          <strong>
            {clash.vaults.map((v) => `“${v.name}”`).join(' and ')} are both pointed at{' '}
            <code>{clash.target}</code>
          </strong>
          . Two vaults reconciling against one target do not stay two vaults: each run reads the
          other's files as notes some device created, and within a few minutes both hold
          everything. That holds even where the rest of their setup differs — sharing this one
          place is enough. Give one of them a different one. If these are in fact different folders
          that happen to share a name, nothing is wrong.
        </div>
      ))}

      <div class="vault-list">
        {list.map((v) => (
          <div class="vault-row" key={v.id} data-current={v.id === activeVaultId.value ? '1' : '0'}>
            <span class="vault-dot vault-dot-lg" style={{ background: v.colour }} />
            <div class="vault-row-main">
              <div class="vault-row-name">
                {v.name}
                {v.id === activeVaultId.value && <span class="vault-badge">open</span>}
              </div>
              <small>{v.targets?.join(' + ') || 'On this device only'}</small>
            </div>
            <div class="vault-swatches" role="group" aria-label={`Colour for ${v.name}`}>
              {VAULT_COLOURS.map((c) => (
                <button
                  key={c}
                  class="vault-swatch"
                  aria-label={c}
                  aria-pressed={v.colour === c}
                  style={{ background: c }}
                  onClick={() => void recolourVault(v.id, c)}
                />
              ))}
            </div>
            <button class="btn" onClick={() => rename(v)}>
              Rename
            </button>
            {v.id !== activeVaultId.value && (
              <button class="btn" onClick={() => void switchToVault(v.id)}>
                Open
              </button>
            )}
            <button
              class="btn"
              title="Open this vault in a second window, so both are on screen at once"
              onClick={() => window.open(urlForVault(v.id), '_blank', 'noopener')}
            >
              New window
            </button>
            <button class="btn btn-danger" disabled={list.length < 2} onClick={() => void remove(v)}>
              Remove
            </button>
          </div>
        ))}
      </div>

      <div class="folder-actions">
        <button class="btn btn-primary" onClick={promptForNewVault}>
          <IconPlus size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          New vault
        </button>
      </div>

      <div class="callout">
        A vault is a separate set of notes with its own sync, its own connected folder and its own
        model connection. Nothing crosses between them — not search, not tags, not{' '}
        <code>[[links]]</code>, and not what gets sent to a model. Switching reloads the app, which
        is what makes that true rather than merely intended.
      </div>

      <div class="callout">
        <strong>They share this browser's storage allowance.</strong> The figure under About is the
        total for every vault on this device, not for the one you are in — and a browser that runs
        low evicts by origin, so a large vault is a risk to a small one beside it. Setting up a
        backend is what makes that a re-download rather than a loss.
      </div>

      {list.length > 1 && (
        <div class="callout">
          This device is called <strong>{settings.value.deviceName}</strong> in version history, in
          every vault. It names the machine rather than the notes, so renaming it under About
          renames it everywhere.
        </div>
      )}
    </>
  )
}
