import { useState } from 'react';
import type { ModelSelection, ModelsResponse } from '../../shared/models';
import { channelLabels, memoryLabels } from '../../shared/teammates';
import { useModels } from '../hooks/use-models';
import { errorMessage } from '../lib/api';
import { teammatePath, type Teammate } from '../lib/teammates';
import { NodAvatar, TeammateAvatar } from '../components/teammate-avatar';
import { createTeammate, toast } from '../components/teammates';

function modelName(data: ModelsResponse | undefined, choice: ModelSelection | null | undefined) {
  if (!data || !choice) return undefined;
  return data.connections
    .find((item) => item.id === choice.connectionId)
    ?.models.find((item) => item.id === choice.modelId)?.name;
}

export function TeammatesPage({
  teammates,
  onNavigate,
  onOpenSettings,
}: {
  teammates: Teammate[];
  onNavigate(path: string): void;
  onOpenSettings(id: string | null): void;
}) {
  const models = useModels();
  const [creating, setCreating] = useState(false);
  const chatModel = modelName(models.data ?? undefined, models.data?.selection);
  async function add() {
    if (creating) return;
    setCreating(true);
    try {
      const created = await createTeammate();
      onNavigate(teammatePath(created.id));
    } catch (cause) {
      toast(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  }
  return (
    <section className="teammates-page" aria-labelledby="teammates-title">
      <div className="teammates-page-head">
        <div>
          <h2 id="teammates-title">Teammates</h2>
          <p>
            Nod is your main assistant. Add teammates for focused jobs, each with its own chat,
            model and memory. Your Vault, approvals and settings stay with Nod.
          </p>
        </div>
        <button
          type="button"
          className="teammate-button teammate-button-primary"
          disabled={creating}
          onClick={() => void add()}
        >
          New teammate
        </button>
      </div>
      <div className="teammates-grid">
        <article className="teammate-card">
          <div className="teammate-card-top">
            <NodAvatar size="lg" />
            <div>
              <h3>
                Nod <span className="teammate-tag">Main</span>
              </h3>
              <p>Your main assistant</p>
            </div>
          </div>
          <div className="teammate-card-facts">
            <span className="teammate-chip">All apps</span>
            <span className="teammate-chip">Your memory</span>
            {chatModel && <span className="teammate-chip">{chatModel}</span>}
          </div>
          <div className="teammate-card-actions">
            <button type="button" className="teammate-button" onClick={() => onNavigate('/')}>
              Open chat
            </button>
            <button
              type="button"
              className="teammate-button teammate-button-ghost"
              onClick={() => onOpenSettings(null)}
            >
              Settings
            </button>
          </div>
        </article>
        {teammates.map((teammate) => {
          const model = modelName(models.data ?? undefined, teammate.model);
          return (
            <article key={teammate.id} className="teammate-card">
              <div className="teammate-card-top">
                <TeammateAvatar name={teammate.name} avatar={teammate.teammate.avatar} size="lg" />
                <div>
                  <h3>{teammate.name}</h3>
                  <p>{teammate.teammate.job || 'Setting up'}</p>
                </div>
              </div>
              <div className="teammate-card-facts">
                <span className="teammate-chip">{model ?? 'Same model as Nod'}</span>
                <span className="teammate-chip">
                  {memoryLabels[teammate.teammate.memory].title.split(',')[0]}
                </span>
                {teammate.teammate.channels.map((channel) => (
                  <span key={channel} className="teammate-chip">
                    {channelLabels[channel]}
                  </span>
                ))}
              </div>
              <div className="teammate-card-actions">
                <button
                  type="button"
                  className="teammate-button"
                  onClick={() => onNavigate(teammatePath(teammate.id))}
                >
                  Open chat
                </button>
                <button
                  type="button"
                  className="teammate-button teammate-button-ghost"
                  onClick={() => onOpenSettings(teammate.id)}
                >
                  Settings
                </button>
              </div>
            </article>
          );
        })}
        <button
          type="button"
          className="teammate-new-card"
          disabled={creating}
          onClick={() => void add()}
        >
          <strong>New teammate</strong>
          <span>It sets itself up in a short chat with you.</span>
        </button>
      </div>
    </section>
  );
}
