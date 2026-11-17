/** Huellicam mobile shell design tokens matching web palette (#FFFBEF / #315F5D). */

export const colors = {
  primary: '#315F5D',
  primarySoft: '#609F9C',
  primaryDark: '#183C3A',
  primaryTint: '#D9E8E4',
  callDark: '#102D2B',
  ink: '#183C3A',
  body: '#454E4E',
  muted: '#607674',
  faint: '#8FA3A1',
  canvas: '#FFFBEF',
  sand: '#F2EDDD',
  card: '#FFFFFF',
  line: '#E4DFD2',
  danger: '#AE4D45',
  dangerTint: '#FBEEE9',
  ok: '#315F5D',
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 } as const;
export const radius = { sm: 8, md: 12, lg: 16, xl: 24, full: 999 } as const;
