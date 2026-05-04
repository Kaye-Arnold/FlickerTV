import type { Metadata } from 'next';
import TabBar from '@/components/Navigation/TabBar';

export const metadata: Metadata = {
  title: 'Search — Flicker.TV',
  description: 'Search 20,000+ public domain films on the Internet Archive.',
};

export default function SearchLayout({
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