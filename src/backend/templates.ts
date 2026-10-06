// Port von src-tauri/src/templates.rs. Vorlagen enthalten nur Namen, nie Beträge.
import type { TemplateInfo } from '../api';

export interface Tpl extends TemplateInfo {
  /** Standard-Aufteilung der Posten */
  split: 'income' | 'equal';
}

export const TEMPLATES: Tpl[] = [
  {
    id: 'paar', name: 'Paar',
    description: 'Gemeinsame Wohnung, Alltag, Abos und Versicherungen. Kosten nach Einkommen.',
    split: 'income',
    groups: [
      { name: 'Wohnen', items: ['Miete', 'Nebenkosten', 'Strom', 'Internet'] },
      { name: 'Alltag', items: ['Lebensmittel', 'Haushaltsbedarf', 'Drogerie'] },
      { name: 'Abos und Freizeit', items: ['Netflix', 'Spotify', 'Amazon Prime'] },
      { name: 'Versicherungen und Gebühren', items: ['Haftpflicht', 'Hausrat', 'Rundfunkbeitrag (GEZ)'] },
    ],
  },
  {
    id: 'wg', name: 'WG',
    description: 'Gemeinsame Kosten einer Wohngemeinschaft. Alles zu gleichen Teilen.',
    split: 'equal',
    groups: [
      { name: 'Wohnen', items: ['Miete', 'Nebenkosten', 'Strom', 'Internet', 'Rundfunkbeitrag (GEZ)'] },
      { name: 'Gemeinschaft', items: ['Putz- und Spülmittel', 'Küchenbedarf', 'Gemeinsame Einkäufe'] },
      { name: 'Abos', items: ['Netflix', 'Spotify'] },
    ],
  },
  {
    id: 'familie', name: 'Familie',
    description: 'Mit Kindern und Mobilität. Kosten nach Einkommen.',
    split: 'income',
    groups: [
      { name: 'Wohnen', items: ['Miete oder Kreditrate', 'Nebenkosten', 'Strom', 'Internet'] },
      { name: 'Alltag', items: ['Lebensmittel', 'Haushaltsbedarf', 'Drogerie'] },
      { name: 'Kinder', items: ['Betreuung', 'Schule und Material', 'Kleidung', 'Taschengeld'] },
      { name: 'Mobilität', items: ['Kfz-Versicherung', 'Kfz-Steuer', 'Sprit', 'ÖPNV'] },
      { name: 'Abos und Freizeit', items: ['Netflix', 'Spotify', 'Vereine und Hobbys'] },
      { name: 'Versicherungen und Gebühren', items: ['Haftpflicht', 'Hausrat', 'Rundfunkbeitrag (GEZ)'] },
    ],
  },
  {
    id: 'minimal', name: 'Minimalistisch',
    description: 'Nur das Nötigste: Miete, Nebenkosten und Lebensmittel.',
    split: 'income',
    groups: [
      { name: 'Wohnen', items: ['Miete', 'Nebenkosten'] },
      { name: 'Alltag', items: ['Lebensmittel'] },
    ],
  },
  {
    id: 'leer', name: 'Leer',
    description: 'Du legst Gruppen und Posten selbst an.',
    split: 'income',
    groups: [],
  },
];

export const findTemplate = (id: string) => TEMPLATES.find(t => t.id === id);
export const templateInfos = (): TemplateInfo[] =>
  TEMPLATES.map(({ id, name, description, groups }) => ({ id, name, description, groups }));
