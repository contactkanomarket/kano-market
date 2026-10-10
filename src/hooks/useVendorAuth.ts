import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Guards the seller dashboard. Waits for roles to load (otherwise a real seller
 * is briefly "not a vendor" and gets thrown out), then sends signed-out people
 * to the seller sign-in and signed-in non-sellers to their application status.
 */
export function useVendorAuth() {
  const { user, isVendor, isLoading, rolesLoading } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const checking = isLoading || (!!user && rolesLoading);

  useEffect(() => {
    if (checking) return;
    if (!user) {
      navigate(`/vendor/login?redirect=${encodeURIComponent(pathname)}`, { replace: true });
    } else if (!isVendor) {
      navigate("/sell", { replace: true });
    }
  }, [checking, user, isVendor, navigate, pathname]);

  return { isVendor, isLoading: checking, userId: user?.id || null };
}
