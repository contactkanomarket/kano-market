import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

/** Admin pages: send anyone without an unlocked admin session to /admin to sign in. */
export function useAdminAuth() {
  const { user, isLoading, rolesLoading, isAdmin } = useAuth();
  const navigate = useNavigate();
  const checking = isLoading || rolesLoading;

  useEffect(() => {
    if (!checking && (!user || !isAdmin)) {
      navigate("/admin", { replace: true });
    }
  }, [user, checking, isAdmin, navigate]);

  return { user, isLoading: checking, isAdmin };
}
