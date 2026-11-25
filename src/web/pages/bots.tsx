import type { ModelSelection, ModelsResponse } from '../../shared/models';
import { useModels } from '../hooks/use-models';
import { botPath, type Bot } from '../lib/bots';
import { NodAvatar, BotAvatar } from '../components/bot-avatar';
import { newBot } from '../components/bots';

function modelName(data: ModelsResponse | undefined, choice: ModelSelection | null | undefined) {
  if (!data || !choice) return undefined;
  return data.connections
    .find((item) => item.id === choice.connectionId)
    ?.models.find((item) => item.id === choice.modelId)?.name;
}

export function BotsPage({
  bots,
  onNavigate,
  onOpenSettings,
}: {
  bots: Bot[];
  onNavigate(path: string): void;
  onOpenSettings(id: string | null): void;
}) {
  const models = useModels();
  const chatModel = modelName(models.data ?? undefined, models.data?.selection);
  return (
    <section className="bots-page" aria-labelledby="bots-title">
      <div className="bots-page-head">
        <div>
          <h2 id="bots-title">Bots</h2>
          <p>
            Nod is your main assistant. Add bots for focused jobs, each with its own chat and model.
            They share Nod’s memory, and your Vault, approvals and settings stay with Nod.
          </p>
        </div>
        <button type="button" className="bot-button bot-button-primary" onClick={newBot}>
          New bot
        </button>
      </div>
      <div className="bots-grid">
        <article className="bot-card">
          <div className="bot-card-top">
            <NodAvatar size="lg" />
            <div>
              <h3>
                Nod <span className="bot-tag">Main</span>
              </h3>
              <p>Your main assistant</p>
            </div>
          </div>
          <div className="bot-card-facts">
            <span className="bot-chip">All apps</span>
            <span className="bot-chip">Your memory</span>
            {chatModel && <span className="bot-chip">{chatModel}</span>}
          </div>
          <div className="bot-card-actions">
            <button type="button" className="bot-button" onClick={() => onNavigate('/')}>
              Open chat
            </button>
            <button
              type="button"
              className="bot-button bot-button-ghost"
              onClick={() => onOpenSettings(null)}
            >
              Settings
            </button>
          </div>
        </article>
        {bots.map((bot) => {
          const model = modelName(models.data ?? undefined, bot.model);
          return (
            <article key={bot.id} className="bot-card">
              <div className="bot-card-top">
                <BotAvatar name={bot.name} avatar={bot.avatar} size="lg" />
                <div>
                  <h3>{bot.name}</h3>
                  <p>{bot.job || 'No job yet'}</p>
                </div>
              </div>
              <div className="bot-card-facts">
                <span className="bot-chip">All apps</span>
                <span className="bot-chip">Shares Nod’s memory</span>
                <span className="bot-chip">
                  {model ?? `Default${chatModel ? ` (${chatModel})` : ''}`}
                </span>
              </div>
              <div className="bot-card-actions">
                <button
                  type="button"
                  className="bot-button"
                  onClick={() => onNavigate(botPath(bot.id))}
                >
                  Open chat
                </button>
                <button
                  type="button"
                  className="bot-button bot-button-ghost"
                  onClick={() => onOpenSettings(bot.id)}
                >
                  Edit
                </button>
              </div>
            </article>
          );
        })}
        <button type="button" className="bot-new-card" onClick={newBot}>
          <strong>New bot</strong>
          <span>Tell it what to do in its chat.</span>
        </button>
      </div>
    </section>
  );
}
