import type { Metadata } from 'next';
import TabBar from '@/components/Navigation/TabBar';

export const metadata: Metadata = {
  title: 'My Watchlist — Flicker.TV',
  description: 'Your saved public domain films on Flicker.TV.',
};

export default function WatchlistLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {children}
      <TabBar />
    </>
  );
}