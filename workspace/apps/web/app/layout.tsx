import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Patrimônio — Gestão familiar",
  description: "Gestão patrimonial, projeções e recomendações auditáveis.",
  manifest: "/manifest.webmanifest",
  other: { "apple-mobile-web-app-capable": "yes" },
  appleWebApp: { capable: true, title: "Juanca", statusBarStyle: "default" },
  icons: { icon: [{ url: "/juanca-icon.png", type: "image/png" }], apple: "/juanca-app-180.png" },
  openGraph: {
    title: "Patrimônio",
    description: "Gestão patrimonial familiar com dados rastreáveis.",
    images: [{ url: "/patrimonio-social.png", width: 1730, height: 909 }],
  },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#10263c" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
