import type { HouseholdInfo } from './api';
import { DeleteButton, confirmDelete } from './ui';

interface Props {
  list: HouseholdInfo[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onImport: () => void;
  onDelete: (id: string) => void;
}

export function Start({ list, onOpen, onNew, onImport, onDelete }: Props) {
  const drop = async (h: HouseholdInfo) => {
    if (await confirmDelete(`Haushalt „${h.name}“ mit allen Daten unwiderruflich löschen?`)) onDelete(h.id);
  };
  return (
    <main className="start">
      <h1>BudGit</h1>
      <p className="muted">Welchen Haushalt möchtest du öffnen?</p>
      <ul className="slots">
        {list.map(h => (
          <li key={h.id}>
            <button className="slot" onClick={() => onOpen(h.id)}>
              <span className="slot-name">{h.name}</span>
              <span className="muted">{h.members.join(' und ')}</span>
            </button>
            <DeleteButton label={`${h.name} löschen`} onClick={() => drop(h)} />
          </li>
        ))}
      </ul>
      <div className="row">
        <button className="btn primary" onClick={onNew}>Neuen Haushalt anlegen</button>
        <button className="btn" onClick={onImport}>Speicherstand importieren</button>
      </div>
    </main>
  );
}
