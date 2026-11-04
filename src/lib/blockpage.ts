import type { Category } from './constants';

/** Calm and honest, and fit for a child who landed here by accident. */
export const CATEGORY_SENTENCES: Record<Category, readonly string[]> = {
  adult: [
    'You can leave this behind right now. Nothing is lost.',
    'If something you saw made you uneasy, talk to someone you trust.',
    'This can wait forever. Your day cannot.',
  ],
  gambling: [
    'The odds are built against you. Your money is safer with you.',
    'Chasing a loss usually ends in a bigger one.',
    'The bet you do not place is money you still have.',
  ],
  gore: [
    'Images like these can stay with you for a long time. You do not need to see them.',
    'It is fine to look away. Nothing here needs your attention.',
    'If something you saw is still on your mind, talk to someone you trust.',
  ],
};

export const GENERAL_SENTENCE = 'You can leave this behind right now. Nothing is lost.';

export const IDEAS = [
  'Drink a glass of water',
  'Take a ten-minute walk',
  'Message a friend',
  'Read a few pages of a book',
  'Stretch for a minute',
  'Step outside for some fresh air',
  'Tidy one small thing nearby',
  'Do the task you have been putting off',
] as const;

/** A few different items, in random order. */
export function pickSome<T>(items: readonly T[], count: number, random: () => number = Math.random): T[] {
  const pool = [...items];
  const picked: T[] = [];
  while (picked.length < count && pool.length) picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
  return picked;
}
