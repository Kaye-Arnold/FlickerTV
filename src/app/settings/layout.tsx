import type { Metadata } from 'next';
import TabBar from '@/components/Navigation/TabBar';

export const metadata: Metadata = {
  title: 'Settings — Flicker.TV',
};

export default function SettingsLayout({
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