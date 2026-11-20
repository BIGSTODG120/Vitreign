const entries = [
  ['dunes', 'The Dune Sea', '2026-10-24', 'Sand & Stone'],
  ['alpine', 'Alpine Silence', '2026-10-22', 'Higher Ground'],
  ['headland', 'Where the Land Ends', '2026-10-19', 'At the Waterline'],
  ['woodland', 'Into the Pines', '2026-10-17', 'Higher Ground'],
  ['golden', 'Harvest Light', '2026-10-14', 'Higher Ground'],
  ['nightfall', 'After Midnight', '2026-10-12', 'Sand & Stone'],
  ['afterglow', 'Last Light', '2026-10-09', 'At the Waterline'],
  ['glacier', 'Blue Hour', '2026-10-06', 'At the Waterline'],
  ['cascade', 'Falling Water', '2026-10-03', 'At the Waterline'],
];

export const samples = entries.map(([id, title, date, collection]) => ({
  id, title, date, collection, type: id === 'headland' ? 'video' : 'photo',
  duration: id === 'headland' ? '00:07' : '',
  thumb: `/media/${id}.webp`,
  src: `/media/${id}.${id === 'headland' ? 'mp4' : 'webp'}`,
}));
