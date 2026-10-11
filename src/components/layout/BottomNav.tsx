import { Home, Package, Heart, User, MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useConversations } from "@/hooks/useChat";
import { BubbleTabBar, type TabItem } from "@/components/layout/BubbleTabBar";

/** The shopper's tab bar. */
export function useShopperTabs(): TabItem[] {
  const { t } = useTranslation();
  const { unreadCount } = useConversations();
  return [
    { icon: Home, label: t("nav.home"), href: "/" },
    { icon: Package, label: t("nav.orders"), href: "/orders" },
    { icon: MessageCircle, label: t("nav.chat"), href: "/messages", badge: unreadCount },
    { icon: Heart, label: t("nav.favorites"), href: "/wishlist" },
    { icon: User, label: t("nav.profile"), href: "/profile" },
  ];
}

export function BottomNav() {
  return <BubbleTabBar items={useShopperTabs()} />;
}
