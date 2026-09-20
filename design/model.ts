export interface Action {
  label: string;
  target: string;
  variant: string;
  submit?: boolean;
  disabled?: boolean;
  decision?: string;
}
export interface Screen {
  id: string;
  title: string;
  section: string;
  eyebrow: string;
  subtitle: string;
  kind?: 'overlay';
  status?: string;
  actions: Action[];
  scenarios?: Action[];
  notice?: { tone: string; text: string };
  metrics?: { label: string; value: string; note: string }[];
  cards?: { title: string; body: string; tag?: string; target?: string; download?: string }[];
  table?: { title: string; columns: string[]; rows: { cells: string[]; target?: string }[] };
  form?: {
    id: string;
    label: string;
    value: string;
    kind: string;
    required?: boolean;
    options?: string[];
  }[];
  timeline?: { title: string; body: string; state: string; target?: string }[];
  context?: { label: string; value: string }[];
  code?: { title: string; value: string; caption: string };
  downloadContent?: string;
}
export interface PrototypeSpec {
  version: string;
  start: string;
  name: string;
  workspace: string;
  nav: { label: string; target: string; glyph: string }[];
  screens: Screen[];
  flows: { name: string; screens: string[] }[];
}
