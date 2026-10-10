import { VendorLayout, useVendorAuth } from "@/components/vendor/VendorLayout";
import { useVendorProducts } from "@/hooks/useVendorProducts";
import { useProductMutations } from "@/hooks/useProductMutations";
import { useFeaturedUntil } from "@/hooks/usePromotions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Package, Plus, MoreVertical, Pencil, Trash2, Eye, EyeOff, PackageX, CheckCircle, Star, AlertTriangle, Search, Megaphone } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "react-router-dom";
import { useState, useMemo } from "react";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export default function VendorProducts() {
  const { userId } = useVendorAuth();
  const { data: products, isLoading, refetch } = useVendorProducts(userId);
  const { deleteProduct, toggleProductStatus } = useProductMutations(userId);
  const { toast } = useToast();
  const { data: featuredUntil } = useFeaturedUntil(userId);
  
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [stockEdit, setStockEdit] = useState<{ id: string; name: string; current: number } | null>(null);
  const [newStock, setNewStock] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState("all");

  // Filter products
  const filteredProducts = useMemo(() => {
    if (!products) return [];
    
    let filtered = products;
    
    // Filter by search
    if (searchQuery) {
      filtered = filtered.filter(p => 
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.category?.name.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }
    
    // Filter by tab
    switch (activeTab) {
      case "active":
        filtered = filtered.filter(p => p.is_active && p.stock_quantity > 0);
        break;
      case "soldout":
        filtered = filtered.filter(p => p.stock_quantity === 0);
        break;
      case "inactive":
        filtered = filtered.filter(p => !p.is_active);
        break;
      case "featured":
        filtered = filtered.filter(p => p.featured);
        break;
    }
    
    return filtered;
  }, [products, searchQuery, activeTab]);

  // Stats
  const stats = useMemo(() => {
    if (!products) return { total: 0, active: 0, soldOut: 0, featured: 0, lowStock: 0 };
    return {
      total: products.length,
      active: products.filter(p => p.is_active && p.stock_quantity > 0).length,
      soldOut: products.filter(p => p.stock_quantity === 0).length,
      featured: products.filter(p => p.featured).length,
      lowStock: products.filter(p => p.stock_quantity > 0 && p.stock_quantity < 5).length,
    };
  }, [products]);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: "NGN",
      minimumFractionDigits: 0,
    }).format(amount);
  };

  const handleDelete = () => {
    if (deleteId) {
      deleteProduct.mutate(deleteId);
      setDeleteId(null);
    }
  };

  const updateStock = async (productId: string, quantity: number) => {
    const { error } = await supabase
      .from("products")
      .update({ stock_quantity: quantity })
      .eq("id", productId);

    if (error) {
      toast({
        title: "Error updating stock",
        description: error.message,
        variant: "destructive",
      });
    } else {
      toast({
        title: quantity === 0 ? "Marked as sold out" : "Stock updated",
        description: quantity === 0 ? "Product is now marked as sold out" : `Stock updated to ${quantity} units`,
      });
      refetch();
    }
  };

  const handleStockUpdate = () => {
    if (stockEdit && newStock !== "") {
      updateStock(stockEdit.id, parseInt(newStock, 10));
      setStockEdit(null);
      setNewStock("");
    }
  };

  const featuredLabel = (productId: string) => {
    const until = featuredUntil?.get(productId);
    return until ? `Featured until ${format(new Date(until), "d MMM")}` : "Featured";
  };

  return (
    <VendorLayout title="Products">
      <div className="space-y-6">
        {/* Stats Cards - Scrollable on mobile */}
        <div className="flex md:grid md:grid-cols-5 gap-2 md:gap-3 overflow-x-auto pb-2 -mx-4 px-4 md:mx-0 md:px-0 scrollbar-hide">
          <Card className="flex-shrink-0 w-[140px] md:w-auto p-3 md:p-4 bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
            <div className="flex items-center gap-2 md:gap-3">
              <div className="p-1.5 md:p-2 rounded-full bg-primary/20">
                <Package className="h-3.5 w-3.5 md:h-4 md:w-4 text-primary" />
              </div>
              <div>
                <p className="text-xl md:text-2xl font-bold">{stats.total}</p>
                <p className="text-[10px] md:text-xs text-muted-foreground">Total</p>
              </div>
            </div>
          </Card>
          
          <Card className="flex-shrink-0 w-[140px] md:w-auto p-3 md:p-4 bg-gradient-to-br from-green-500/10 to-green-500/5 border-green-500/20">
            <div className="flex items-center gap-2 md:gap-3">
              <div className="p-1.5 md:p-2 rounded-full bg-green-500/20">
                <CheckCircle className="h-3.5 w-3.5 md:h-4 md:w-4 text-green-600" />
              </div>
              <div>
                <p className="text-xl md:text-2xl font-bold text-green-600">{stats.active}</p>
                <p className="text-[10px] md:text-xs text-muted-foreground">Active</p>
              </div>
            </div>
          </Card>
          
          <Card className="flex-shrink-0 w-[140px] md:w-auto p-3 md:p-4 bg-gradient-to-br from-amber-500/10 to-amber-500/5 border-amber-500/20">
            <div className="flex items-center gap-2 md:gap-3">
              <div className="p-1.5 md:p-2 rounded-full bg-amber-500/20">
                <Star className="h-3.5 w-3.5 md:h-4 md:w-4 text-amber-600" />
              </div>
              <div>
                <p className="text-xl md:text-2xl font-bold text-amber-600">{stats.featured}</p>
                <p className="text-[10px] md:text-xs text-muted-foreground">Featured</p>
              </div>
            </div>
          </Card>
          
          <Card className="flex-shrink-0 w-[140px] md:w-auto p-3 md:p-4 bg-gradient-to-br from-red-500/10 to-red-500/5 border-red-500/20">
            <div className="flex items-center gap-2 md:gap-3">
              <div className="p-1.5 md:p-2 rounded-full bg-red-500/20">
                <PackageX className="h-3.5 w-3.5 md:h-4 md:w-4 text-red-600" />
              </div>
              <div>
                <p className="text-xl md:text-2xl font-bold text-red-600">{stats.soldOut}</p>
                <p className="text-[10px] md:text-xs text-muted-foreground">Sold Out</p>
              </div>
            </div>
          </Card>
          
          <Card className="flex-shrink-0 w-[140px] md:w-auto p-3 md:p-4 bg-gradient-to-br from-orange-500/10 to-orange-500/5 border-orange-500/20">
            <div className="flex items-center gap-2 md:gap-3">
              <div className="p-1.5 md:p-2 rounded-full bg-orange-500/20">
                <AlertTriangle className="h-3.5 w-3.5 md:h-4 md:w-4 text-orange-600" />
              </div>
              <div>
                <p className="text-xl md:text-2xl font-bold text-orange-600">{stats.lowStock}</p>
                <p className="text-[10px] md:text-xs text-muted-foreground">Low Stock</p>
              </div>
            </div>
          </Card>
        </div>

        {/* Header with Search and Add Button */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search products..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button asChild className="gap-2">
            <Link to="/vendor/products/new">
              <Plus className="h-4 w-4" />
              Add Product
            </Link>
          </Button>
        </div>

        {/* Tabs - Scrollable on mobile */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
            <TabsList className="inline-flex md:w-full md:grid md:grid-cols-5 gap-1">
              <TabsTrigger value="all" className="text-xs px-4">All ({stats.total})</TabsTrigger>
              <TabsTrigger value="active" className="text-xs px-4">Active</TabsTrigger>
              <TabsTrigger value="soldout" className="text-xs px-4">Sold Out</TabsTrigger>
              <TabsTrigger value="inactive" className="text-xs px-4">Hidden</TabsTrigger>
              <TabsTrigger value="featured" className="text-xs px-4">Featured</TabsTrigger>
            </TabsList>
          </div>
        </Tabs>

        {/* Products List */}
        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="h-48 w-full rounded-xl" />
            ))}
          </div>
        ) : filteredProducts.length === 0 ? (
          <Card className="text-center py-16 px-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <Package className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-lg mb-2">
              {searchQuery || activeTab !== "all" ? "No products found" : "No products yet"}
            </h3>
            <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
              {searchQuery || activeTab !== "all" 
                ? "Try adjusting your search or filters"
                : "Start by adding your first product listing to reach customers"
              }
            </p>
            {!searchQuery && activeTab === "all" && (
              <Button asChild>
                <Link to="/vendor/products/new">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Your First Product
                </Link>
              </Button>
            )}
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredProducts.map((product) => (
              <Card 
                key={product.id} 
                className={`overflow-hidden group transition-all hover:shadow-lg ${
                  product.stock_quantity === 0 ? "opacity-75" : ""
                }`}
              >
                {/* Product Image */}
                <div className="relative aspect-square bg-muted">
                  {product.product_images?.[0] ? (
                    <img
                      src={product.product_images[0].url}
                      alt={product.name}
                      className={`h-full w-full object-cover transition-transform group-hover:scale-105 ${
                        product.stock_quantity === 0 ? "grayscale" : ""
                      }`}
                    />
                  ) : (
                    <div className="h-full w-full flex items-center justify-center">
                      <Package className="h-12 w-12 text-muted-foreground/50" />
                    </div>
                  )}
                  
                  {/* Sold Out Overlay */}
                  {product.stock_quantity === 0 && (
                    <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                      <div className="bg-red-600 text-white px-6 py-2 rounded-full font-bold text-lg shadow-lg">
                        SOLD OUT
                      </div>
                    </div>
                  )}
                  
                  {/* Status Badges */}
                  <div className="absolute top-2 left-2 flex flex-col gap-1.5">
                    {product.featured && (
                      <Badge className="bg-amber-500 hover:bg-amber-600 gap-1 shadow-md">
                        <Star className="h-3 w-3" />
                        {featuredLabel(product.id)}
                      </Badge>
                    )}
                    {!product.is_active && product.stock_quantity > 0 && (
                      <Badge variant="secondary" className="shadow-md">
                        <EyeOff className="h-3 w-3 mr-1" />
                        Hidden
                      </Badge>
                    )}
                    {product.stock_quantity > 0 && product.stock_quantity < 5 && (
                      <Badge variant="outline" className="bg-orange-100 text-orange-700 border-orange-300 shadow-md">
                        <AlertTriangle className="h-3 w-3 mr-1" />
                        {product.stock_quantity} left
                      </Badge>
                    )}
                  </div>
                  
                  {/* Actions Menu */}
                  <div className="absolute top-2 right-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="secondary" size="icon" className="h-8 w-8 shadow-md">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem asChild>
                          <Link to={`/vendor/products/${product.id}`}>
                            <Pencil className="h-4 w-4 mr-2" />
                            Edit Product
                          </Link>
                        </DropdownMenuItem>
                        
                        <DropdownMenuItem
                          onClick={() => {
                            setStockEdit({
                              id: product.id,
                              name: product.name,
                              current: product.stock_quantity,
                            });
                            setNewStock(product.stock_quantity.toString());
                          }}
                        >
                          <Package className="h-4 w-4 mr-2" />
                          Update Stock
                        </DropdownMenuItem>
                        
                        <DropdownMenuSeparator />
                        
                        <DropdownMenuItem asChild className="text-amber-600 focus:text-amber-700">
                          <Link to={`/vendor/promote?product=${product.id}`}>
                            <Megaphone className="h-4 w-4 mr-2" />
                            Promote on homepage
                          </Link>
                        </DropdownMenuItem>
                        
                        {product.stock_quantity > 0 ? (
                          <DropdownMenuItem onClick={() => updateStock(product.id, 0)}>
                            <PackageX className="h-4 w-4 mr-2" />
                            Mark Sold Out
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={() => {
                              setStockEdit({
                                id: product.id,
                                name: product.name,
                                current: 0,
                              });
                              setNewStock("10");
                            }}
                          >
                            <CheckCircle className="h-4 w-4 mr-2" />
                            Restock
                          </DropdownMenuItem>
                        )}
                        
                        <DropdownMenuItem
                          onClick={() =>
                            toggleProductStatus.mutate({
                              productId: product.id,
                              isActive: !product.is_active,
                            })
                          }
                        >
                          {product.is_active ? (
                            <>
                              <EyeOff className="h-4 w-4 mr-2" />
                              Hide Listing
                            </>
                          ) : (
                            <>
                              <Eye className="h-4 w-4 mr-2" />
                              Show Listing
                            </>
                          )}
                        </DropdownMenuItem>
                        
                        <DropdownMenuSeparator />
                        
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setDeleteId(product.id)}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete Product
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                
                {/* Product Info */}
                <div className="p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0 flex-1">
                      <h3 className="font-semibold truncate">{product.name}</h3>
                      <p className="text-sm text-muted-foreground">
                        {product.category?.name || "Uncategorized"}
                      </p>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-lg font-bold">{formatCurrency(product.price)}</span>
                      {product.compare_at_price && product.compare_at_price > product.price && (
                        <span className="text-sm text-muted-foreground line-through ml-2">
                          {formatCurrency(product.compare_at_price)}
                        </span>
                      )}
                    </div>
                    {product.stock_quantity > 4 && (
                      <Badge variant="secondary" className="text-xs">
                        {product.stock_quantity} in stock
                      </Badge>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent className="max-w-[90vw] md:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Product</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this product. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Stock Update Dialog */}
      <Dialog open={!!stockEdit} onOpenChange={() => setStockEdit(null)}>
        <DialogContent className="max-w-[90vw] md:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Update Stock</DialogTitle>
            <DialogDescription className="truncate">
              {stockEdit?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="stock">Stock Quantity</Label>
            <Input
              id="stock"
              type="number"
              min="0"
              value={newStock}
              onChange={(e) => setNewStock(e.target.value)}
              className="mt-2"
              placeholder="Enter new stock quantity"
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setStockEdit(null)}>
              Cancel
            </Button>
            <Button onClick={handleStockUpdate}>
              Update Stock
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </VendorLayout>
  );
}