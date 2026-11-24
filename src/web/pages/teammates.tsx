import { useState, type ReactNode } from 'react';
import type { ModelSelection, ModelsResponse } from '../../shared/models';
import { channelLabels, memoryLabels } from '../../shared/teammates';
import { useModels } from '../hooks/use-models';
import { teammatePath, type Teammate } from '../lib/teammates';
import { Plus } from '../components/icons';
import { NodAvatar, TeammateAvatar } from '../components/teammate-avatar';
import { createTeammate, toastError } from '../components/teammates';
import { Button } from '../components/ui';

function modelName(data: ModelsResponse | undefined, choice: ModelSelection | null | undefined) {
  if (!data || !choice) return undefined;
  return data.connections
    .find((item) => item.id === choice.connectionId)
    ?.models.find((item) => item.id === choice.modelId)?.name;
}

function Card({
  avatar,
  name,
  job,
  facts,
  onOpen,
  onSettings,
}: {
  avatar: ReactNode;
  name: string;
  job: string;
  facts: Array<string | undefined>;
  onOpen(): void;
  onSettings(): void;
}) {
  return (
    <article className="teammate-card">
      <div className="teammate-card-top">
        {avatar}
        <div>
          <h3>{name}</h3>
          <p>{job}</p>
        </div>
      </div>
      <p className="teammate-card-facts">{facts.filter(Boolean).join(' · ')}</p>
      <div className="teammate-card-actions">
        <Button variant="outline" size="sm" onClick={onOpen}>
          Open chat
        </Button>
        <Button variant="ghost" size="sm" onClick={onSettings}>
          Settings
        </Button>
      </div>
    </article>
  );
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
  const data = models.data ?? undefined;
  const [creating, setCreating] = useState(false);
  async function add() {
    if (creating) return;
    setCreating(true);
    try {
      const created = await createTeammate();
      onNavigate(teammatePath(created.id));
    } catch (cause) {
      toastError(cause);
    } finally {
      setCreating(false);
    }
  }
  return (
    <section className="content-page secondary-page teammates-page" aria-label="Teammates">
      <header className="page-heading secondary-heading">
        <Button size="sm" disabled={creating} onClick={() => void add()}>
          <Plus size={16} aria-hidden="true" />
          New teammate
        </Button>
      </header>
      <div className="teammates-grid">
        <Card
          avatar={<NodAvatar size="lg" />}
          name="Nod"
          job="Your main assistant"
          facts={[modelName(data, data?.selection), 'All apps', 'Your memory']}
          onOpen={() => onNavigate('/')}
          onSettings={() => onOpenSettings(null)}
        />
        {teammates.map((teammate) => (
          <Card
            key={teammate.id}
            avatar={
              <TeammateAvatar name={teammate.name} avatar={teammate.teammate.avatar} size="lg" />
            }
            name={teammate.name}
            job={teammate.teammate.job || 'Setting up'}
            facts={[
              modelName(data, teammate.model) ?? 'Same model as Nod',
              memoryLabels[teammate.teammate.memory].title.split(',')[0],
              ...teammate.teammate.channels.map((channel) => channelLabels[channel]),
            ]}
            onOpen={() => onNavigate(teammatePath(teammate.id))}
            onSettings={() => onOpenSettings(teammate.id)}
          />
        ))}
      </div>
    </section>
  );
}
