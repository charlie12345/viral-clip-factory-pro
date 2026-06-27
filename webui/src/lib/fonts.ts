export interface SubtitleFont {
  id: string | null;
  label: string;
  group: 'social' | 'windows' | 'open' | 'header' | '';
}

export const FONT_LIST: SubtitleFont[] = [
  { id: null,                     label: '— Style Default',                group: '' },
  { id: null,                     label: '── Bundled Creator Fonts ──',    group: 'header' },
  { id: 'Montserrat Black',       label: 'Montserrat Black',              group: 'social' },
  { id: 'Montserrat Bold',        label: 'Montserrat Bold',               group: 'social' },
  { id: 'Anton',                  label: 'Anton',                         group: 'social' },
  { id: 'Bebas Neue',             label: 'Bebas Neue',                    group: 'social' },
  { id: 'Oswald Bold',            label: 'Oswald Bold',                   group: 'social' },
  { id: 'Poppins Black',          label: 'Poppins Black',                 group: 'social' },
  { id: 'Poppins Bold',           label: 'Poppins Bold',                  group: 'social' },
  { id: 'Barlow Condensed Black', label: 'Barlow Condensed Black',        group: 'social' },
  { id: 'Archivo Black',          label: 'Archivo Black',                 group: 'social' },
  { id: 'Rajdhani Bold',          label: 'Rajdhani Bold',                 group: 'social' },
  { id: null,                     label: '── Bundled Compatible Fonts ──', group: 'header' },
  { id: 'Liberation Sans',        label: 'Arial Bold (Liberation Sans)',   group: 'windows' },
  { id: 'Liberation Serif',       label: 'Times New Roman (Liberation Serif)', group: 'windows' },
  { id: 'Liberation Mono',        label: 'Courier New (Liberation Mono)', group: 'windows' },
  { id: 'Liberation Sans Narrow', label: 'Arial Narrow (Liberation Sans Narrow)', group: 'windows' },
  { id: 'Comic Neue',             label: 'Comic Neue (Comic Sans)',        group: 'windows' },
  { id: null,                     label: '── Open Source Alternatives ──', group: 'header' },
  { id: 'DejaVu Sans',            label: 'DejaVu Sans Bold',              group: 'open' },
  { id: 'DejaVu Serif',           label: 'DejaVu Serif Bold',             group: 'open' },
];
