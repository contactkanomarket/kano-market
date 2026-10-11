import { Link } from "react-router-dom";
import { brandLogo } from "@/assets/brand-logo";
import { Facebook, Instagram, Twitter } from "lucide-react";
import { useCategories } from "@/hooks/useProducts";

export function Footer() {
  const { data: categories } = useCategories();

  return (
    <footer className="border-t bg-primary text-primary-foreground">
      <div className="container py-12 md:py-16">
        <div className="grid gap-8 md:grid-cols-4">
          <div className="space-y-4">
            <Link to="/" className="flex items-center gap-2">
              <img src={brandLogo} alt="" className="h-10 w-auto rounded-md bg-background object-contain p-0.5" />
              <span className="font-display text-2xl font-bold">Kano Market</span>
            </Link>
            <p className="text-sm text-primary-foreground/80">
              The marketplace for Kano. Local sellers, one cart.
            </p>
            <div className="flex gap-4">
              <a href="#" className="text-primary-foreground/80 transition-colors hover:text-primary-foreground" aria-label="Facebook">
                <Facebook className="h-5 w-5" />
              </a>
              <a href="#" className="text-primary-foreground/80 transition-colors hover:text-primary-foreground" aria-label="Instagram">
                <Instagram className="h-5 w-5" />
              </a>
              <a href="#" className="text-primary-foreground/80 transition-colors hover:text-primary-foreground" aria-label="Twitter">
                <Twitter className="h-5 w-5" />
              </a>
            </div>
          </div>

          <div className="space-y-4">
            <h4 className="font-display text-lg font-semibold">Shop</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <Link to="/products" className="text-primary-foreground/80 hover:text-primary-foreground">
                  All products
                </Link>
              </li>
              {(categories || []).map((category) => (
                <li key={category.id}>
                  <Link to={`/products?category=${category.slug}`} className="text-primary-foreground/80 hover:text-primary-foreground">
                    {category.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-4">
            <h4 className="font-display text-lg font-semibold">Support</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <Link to="/chat" className="text-primary-foreground/80 hover:text-primary-foreground">Contact Us</Link>
              </li>
              <li>
                <Link to="/help" className="text-primary-foreground/80 hover:text-primary-foreground">FAQs</Link>
              </li>
              <li>
                <Link to="/help" className="text-primary-foreground/80 hover:text-primary-foreground">Shipping Info</Link>
              </li>
              <li>
                <Link to="/help" className="text-primary-foreground/80 hover:text-primary-foreground">Returns Policy</Link>
              </li>
            </ul>
          </div>

          <div className="space-y-4">
            <h4 className="font-display text-lg font-semibold">Sell on Kano Market</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <Link to="/sell" className="text-primary-foreground/80 hover:text-primary-foreground">Become a Vendor</Link>
              </li>
              <li>
                <Link to="/vendor/dashboard" className="text-primary-foreground/80 hover:text-primary-foreground">Vendor Dashboard</Link>
              </li>
              <li>
                <Link to="/shops" className="text-primary-foreground/80 hover:text-primary-foreground">Browse Shops</Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-12 border-t border-primary-foreground/20 pt-8 text-center text-sm text-primary-foreground/60">
          <p>&copy; {new Date().getFullYear()} Kano Market. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
