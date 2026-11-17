import { useState } from 'react';
import { KeepOutList } from './keep-out-list';
import { Button, Notice, Switch } from './ui';
import { api, errorMessage, post } from '../lib/api';
import { usePageData } from '../hooks/use-page-data';

type Status = {
  available: boolean;
  enabled: boolean;
  keptOut: string[];
  permissions: { accessibility: boolean; screen: boolean };
};
const path = '/api/computer-use';
const permissionText = {
  accessibility: {
    label: 'Accessibility',
    hint: 'Lets Nod read app windows and press their controls.',
  },
  screen: {
    label: 'Screen Recording',
    hint: 'Lets Nod take a picture of one app window when its controls aren’t enough.',
  },
} as const;

export function ComputerUseSettings() {
  const { data, update } = usePageData<Status>(path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!data) return null;
  if (!data.available)
    return (
      <section className="account-region">
        <p className="field-hint">Computer use works in the Nod desktop app on macOS.</p>
      </section>
    );

  async function save(request: () => Promise<Status>) {
    setBusy(true);
    setError('');
    try {
      const saved = await request();
      update(() => saved);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="account-region">
        <div className="account-preference-row">
          <span>Let Nod use apps on this Mac</span>
          <Switch
            checked={data.enabled}
            disabled={busy}
            aria-label="Let Nod use apps on this Mac"
            onCheckedChange={(enabled) =>
              void save(() =>
                api<Status>(path, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
              )
            }
          />
        </div>
        <p className="field-hint">
          Nod opens an app only when your request names it or needs it, and asks before a step that
          sends, saves over, deletes or buys anything. Browsers and code editors stay view-only;
          terminals, system settings, Finder and password managers are never used.
        </p>
      </section>
      {data.enabled &&
        (['accessibility', 'screen'] as const).map((which) => (
          <section key={which} className="account-region">
            <div className="account-preference-row">
              <span>{permissionText[which].label}</span>
              {data.permissions[which] ? (
                <span className="field-hint">Allowed</span>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void save(() => post<Status>(`${path}/permission`, { which }))}
                >
                  Allow
                </Button>
              )}
            </div>
            <p className="field-hint">
              {permissionText[which].hint}
              {!data.permissions[which] &&
                ' macOS opens System Settings, Privacy & Security; turn on Nod there, then come back.'}
              {!data.permissions[which] &&
                which === 'screen' &&
                ' If you already turned it on, quit and reopen Nod; macOS applies it only after a restart.'}
            </p>
          </section>
        ))}
      {data.keptOut.length > 0 && (
        <section className="account-region">
          <KeepOutList
            title="Kept out of computer use"
            hint="Nod never uses these apps. Tell Nod to add one; only you can remove it here."
            items={data.keptOut}
            removeLabel={(bundle) => `Let Nod use ${bundle} again`}
            disabled={busy}
            onRemove={(bundle) =>
              void save(() =>
                api<Status>(`${path}/keep-out`, {
                  method: 'DELETE',
                  body: JSON.stringify({ bundle }),
                }),
              )
            }
          />
        </section>
      )}
      {error && <Notice onDismiss={() => setError('')}>{error}</Notice>}
    </>
  );
}
