'use strict';
// First-run data: store settings, the six departments, delivery zones and a demo catalogue.
// Demo products use invented brand names. Edit or delete them in Admin > Products.
const { db, get, run, tx, now } = require('./db');

const SETTINGS = {
  store_name: 'Shop-Beta', tagline: 'Everything you need, delivered across Nigeria',
  logo_url: '', announcement: '🚚 Free standard delivery on orders over ₦50,000',
  contact_email: 'hello@shop-beta.example', contact_phone: '', whatsapp: '', address: 'Lagos, Nigeria', pickup_address: '',
  instagram: '', facebook: '', x_twitter: '', tiktok: '',
  free_shipping_threshold: '50000', express_multiplier: '1.5', return_days: '7',
  tax_note: 'Prices are in Naira and include VAT where applicable.', ga_id: '', meta_pixel_id: '',
  pod_enabled: '1', paystack_enabled: '1',
};

const STORES = [
  ['fashion', 'Shop-Beta Fashion', 'Fashion', '👗', 'Style for every day', 'Everything You Love In One Place', 'Clothes, shoes, bags and accessories for the whole family, delivered across Nigeria.', 'Shop Now', 'New season styles', 'Fresh looks added every week', 'Shoes & bags', 'Great deals on selected pieces', 'Free delivery over ₦50,000', 'Shop more, save more.'],
  ['supermarket', 'Shop-Beta Supermarket', 'Supermarket', '🛒', 'Fresh groceries to your door', 'More Choices, Better Living', 'Groceries, drinks and household essentials at honest prices.', 'Start Shopping', 'Weekly essentials', 'Stock up on pantry staples', 'Fresh & daily', 'Bread, produce and more', 'Free delivery on big baskets', 'Free standard delivery over ₦50,000.'],
  ['beauty', 'Shop-Beta Beauty', 'Beauty', '💄', 'Glow your way', 'Beauty That Loves Your Skin', 'Skincare, makeup, hair care and fragrance picked for you.', 'Explore Beauty', 'Skin first', 'Serums, creams and cleansers', 'Hair & body', 'Care that works', 'Treat yourself', 'Gifts and sets for every budget.'],
  ['electronics', 'Shop-Beta Electronics', 'Electronics', '🎧', 'Smart tech, fair prices', 'Premium Products Great Prices', 'Phones, audio, power and home tech with delivery across Nigeria.', 'Shop Tech', 'Power up', 'Chargers, power banks and cables', 'Sound & wearables', 'Earbuds, speakers and watches', 'Tech deals this week', 'Save on top-rated gadgets.'],
  ['pharmacy', 'Shop-Beta Pharmacy', 'Pharmacy', '💊', 'Health and wellness essentials', 'Your Health, Our Priority', 'Over-the-counter care, vitamins and health devices delivered safely.', 'Shop Health', 'Everyday wellness', 'Vitamins and daily care', 'Home health', 'Monitors, thermometers and first aid', 'Free shipping over ₦50,000', 'Care that comes to you.'],
  ['food', 'Shop-Beta Food & Kitchen', 'Food', '🍲', 'Cook it. Love it.', 'Taste The Best, Delivered Fresh', 'Local ingredients, pantry staples and kitchenware for your next meal.', 'Order Now', 'Cook at home', 'Spices, grains and soup ingredients', 'Kitchen tools', 'Pots, pans and more', 'Party jollof season', 'Everything for a great meal.'],
];

const STATE_ROWS = [
  // state, fee, eta, pod
  ['Lagos', 2000, '1–2 days', 1], ['Ogun', 3000, '2–3 days', 1], ['Oyo', 3500, '2–3 days', 1], ['Osun', 3500, '2–4 days', 1],
  ['Ondo', 3800, '2–4 days', 1], ['Ekiti', 3800, '2–4 days', 1], ['Abuja (FCT)', 4000, '2–3 days', 1], ['Kwara', 4000, '2–4 days', 1],
  ['Edo', 4000, '2–4 days', 1], ['Delta', 4200, '2–4 days', 1], ['Rivers', 4500, '2–4 days', 1], ['Anambra', 4500, '2–4 days', 1],
  ['Enugu', 4500, '3–5 days', 1], ['Imo', 4500, '3–5 days', 0], ['Abia', 4500, '3–5 days', 0], ['Ebonyi', 4800, '3–5 days', 0],
  ['Bayelsa', 4800, '3–5 days', 0], ['Akwa Ibom', 4800, '3–5 days', 0], ['Cross River', 4800, '3–5 days', 0], ['Kogi', 4500, '3–5 days', 0],
  ['Nasarawa', 4500, '3–5 days', 0], ['Benue', 4800, '3–5 days', 0], ['Niger', 4800, '3–5 days', 0], ['Plateau', 5000, '3–6 days', 0],
  ['Kaduna', 5000, '3–6 days', 0], ['Kano', 5500, '3–6 days', 0], ['Katsina', 5800, '4–7 days', 0], ['Bauchi', 5800, '4–7 days', 0],
  ['Gombe', 5800, '4–7 days', 0], ['Taraba', 6000, '4–7 days', 0], ['Adamawa', 6000, '4–7 days', 0], ['Jigawa', 6000, '4–7 days', 0],
  ['Kebbi', 6000, '4–7 days', 0], ['Sokoto', 6200, '4–8 days', 0], ['Zamfara', 6200, '4–8 days', 0], ['Yobe', 6500, '4–8 days', 0], ['Borno', 6500, '4–8 days', 0],
];

// category: [slug, name, icon]; product: [name, brand, price, compare, emoji, categorySlug, variants]
// variants: 'S,M,L|Black,Blue' (sizes|colours) or '' for none. Optional 8th item: size label.
const CATALOGUE = {
  fashion: {
    cats: [['women', 'Women', '👗'], ['men', 'Men', '👔'], ['shoes', 'Shoes', '👟'], ['bags', 'Bags', '👜'], ['accessories', 'Accessories', '🕶'], ['kids', 'Kids', '🧒']],
    products: [
      ['Ankara Wrap Dress', 'Zuri', 18500, 24000, '👗', 'women', 'S,M,L,XL|Wine,Teal'],
      ['Classic Slim-Fit Shirt', 'Oak & Co', 12000, 0, '👔', 'men', 'S,M,L,XL|White,Sky Blue'],
      ['Lace-Up Sneakers', 'Stride', 28500, 35000, '👟', 'shoes', '40,41,42,43,44|White,Black'],
      ['Leather Tote Bag', 'Kemi Atelier', 32000, 0, '👜', 'bags', ''],
      ['Aviator Sunglasses', 'Lumen', 9500, 12500, '🕶', 'accessories', ''],
      ['Senator Native Wear Set', 'Adire House', 45000, 55000, '🧥', 'men', 'M,L,XL,XXL|Cream,Navy'],
      ['Block Heel Sandals', 'Stride', 21000, 0, '👡', 'shoes', '37,38,39,40,41|Nude,Black'],
      ['Kids Denim Jacket', 'Little Zuri', 11500, 14500, '🧥', 'kids', '3-4Y,5-6Y,7-8Y|Blue'],
      ['Beaded Statement Necklace', 'Kemi Atelier', 7500, 0, '📿', 'accessories', ''],
      ['Cotton Polo Shirt', 'Oak & Co', 8500, 10500, '👕', 'men', 'S,M,L,XL,XXL|Green,Black,White'],
    ],
  },
  supermarket: {
    cats: [['groceries', 'Groceries', '🛒'], ['drinks', 'Drinks', '🧃'], ['bakery', 'Bakery', '🍞'], ['produce', 'Fresh Produce', '🥦'], ['household', 'Household', '🧺'], ['snacks', 'Snacks', '🍿']],
    products: [
      ['Long Grain Parboiled Rice 5kg', 'Golden Field', 9800, 11500, '🍚', 'groceries', ''],
      ['Vegetable Oil 3L', 'Sunpure', 8900, 0, '🫒', 'groceries', ''],
      ['Fresh Tomatoes Basket', 'Farm Fresh', 3500, 0, '🍅', 'produce', ''],
      ['Sliced Bread Family Loaf', 'Bake & Co', 1800, 0, '🍞', 'bakery', ''],
      ['Orange Juice 1L', 'Sunny Grove', 1500, 0, '🧃', 'drinks', ''],
      ['Table Water 12-pack', 'Aqua Pure', 2400, 2900, '💧', 'drinks', ''],
      ['Instant Noodles Carton', 'Quick Bowl', 6800, 7500, '🍜', 'groceries', ''],
      ['Dish Soap 1L', 'Sparkle', 2200, 0, '🧼', 'household', ''],
      ['Plantain Chips', 'Crunchy Co', 900, 0, '🍌', 'snacks', ''],
      ['Assorted Biscuits Pack', 'Crunchy Co', 1400, 1700, '🍪', 'snacks', ''],
    ],
  },
  beauty: {
    cats: [['skincare', 'Skincare', '🧴'], ['makeup', 'Makeup', '💄'], ['hair', 'Hair', '💇'], ['fragrance', 'Fragrance', '🌸'], ['body', 'Body care', '🧼'], ['tools', 'Tools', '🖌']],
    products: [
      ['Shea Butter Body Cream 200ml', 'Shea Glow', 4500, 5500, '🧴', 'skincare', ''],
      ['Vitamin C Face Serum 30ml', 'Dewy', 8500, 10500, '🧪', 'skincare', ''],
      ['Matte Lipstick Set (3 shades)', 'Rouge Lagos', 9500, 0, '💄', 'makeup', ''],
      ['Soft Focus Foundation Stick', 'Rouge Lagos', 12500, 0, '💄', 'makeup', 'Light,Medium,Tan,Deep|', 'Shade'],
      ['Argan Hair Oil 100ml', 'Crown', 5200, 0, '🧴', 'hair', ''],
      ['Silk Edge Control Gel 4oz', 'Crown', 3200, 0, '💇', 'hair', ''],
      ['Eau de Parfum 50ml', 'Nuit Lagos', 24500, 29000, '🌸', 'fragrance', ''],
      ['African Black Soap (3 bars)', 'Shea Glow', 2800, 0, '🧼', 'body', ''],
      ['Makeup Brush Set (12 pieces)', 'Blend Pro', 7800, 9800, '🖌', 'tools', ''],
      ['Satin Sleep Bonnet', 'Crown', 2500, 0, '✨', 'hair', ''],
    ],
  },
  electronics: {
    cats: [['phones', 'Phones', '📱'], ['audio', 'Audio', '🎧'], ['computing', 'Computing', '💻'], ['wearables', 'Wearables', '⌚'], ['power', 'Power', '🔋'], ['home', 'Home tech', '📺']],
    products: [
      ['Wireless Earbuds Pro', 'Pulse', 24500, 32000, '🎧', 'audio', ''],
      ['10,000mAh Power Bank', 'VoltEdge', 12500, 0, '🔋', 'power', ''],
      ['Smartwatch Fit 2', 'Tempo', 38000, 45000, '⌚', 'wearables', ''],
      ['Bluetooth Speaker 20W', 'Boomline', 21000, 0, '🔊', 'audio', ''],
      ['65W GaN Fast Charger', 'VoltEdge', 9800, 12000, '🔌', 'power', ''],
      ['Nova X5 Smartphone 128GB', 'Nova', 165000, 189000, '📱', 'phones', '|Midnight,Ocean'],
      ['Laptop Backpack 15.6"', 'Carry', 16500, 0, '🎒', 'computing', ''],
      ['Wireless Mouse', 'Glide', 6500, 0, '🖱', 'computing', ''],
      ['Smart LED Bulb (4-pack)', 'Brite', 8800, 0, '💡', 'home', ''],
      ['43" Smart TV', 'Vista', 245000, 279000, '📺', 'home', ''],
    ],
  },
  pharmacy: {
    cats: [['pain', 'Pain & fever', '💊'], ['vitamins', 'Vitamins', '🍊'], ['firstaid', 'First aid', '🩹'], ['devices', 'Health devices', '🩺'], ['baby', 'Mother & baby', '🍼'], ['personal', 'Personal care', '🧴']],
    products: [
      ['Paracetamol 500mg (16 tablets)', 'CareWell', 650, 0, '💊', 'pain', ''],
      ['Vitamin C 1000mg Effervescent (20)', 'CareWell', 3200, 3800, '🍊', 'vitamins', ''],
      ['Daily Multivitamin (60 capsules)', 'CareWell', 6800, 0, '💊', 'vitamins', ''],
      ['Digital Thermometer', 'PulseCheck', 3500, 0, '🌡', 'devices', ''],
      ['Upper-Arm Blood Pressure Monitor', 'PulseCheck', 28500, 34000, '🩺', 'devices', ''],
      ['Adhesive Plasters (100)', 'CareWell', 1500, 0, '🩹', 'firstaid', ''],
      ['Hand Sanitiser 500ml', 'CareWell', 2200, 0, '🧴', 'personal', ''],
      ['Antiseptic Solution 250ml', 'CareWell', 1800, 0, '🧪', 'firstaid', ''],
      ['Baby Diapers Size 3 (50)', 'Snug', 13500, 15500, '🍼', 'baby', ''],
      ['Oral Rehydration Salts (10 sachets)', 'CareWell', 1200, 0, '💧', 'firstaid', ''],
    ],
  },
  food: {
    cats: [['soups', 'Soup ingredients', '🍲'], ['spices', 'Spices', '🧂'], ['grains', 'Grains & flour', '🌾'], ['snacks', 'Snacks', '🍿'], ['drinks', 'Drinks', '🥤'], ['kitchen', 'Kitchenware', '🍳']],
    products: [
      ['Ground Egusi 500g', 'Mama Pot', 3800, 0, '🥣', 'soups', ''],
      ['Jollof Spice Mix 100g', 'Mama Pot', 2200, 0, '🌶', 'spices', ''],
      ['Ofada Rice 2kg', 'Golden Field', 5500, 6500, '🍚', 'grains', ''],
      ['Pounded Yam Flour 1kg', 'Mama Pot', 3400, 0, '🌾', 'grains', ''],
      ['Palm Oil 1L', 'Sunpure', 4200, 0, '🫒', 'soups', ''],
      ['Non-Stick Frying Pan 28cm', 'Cookwise', 11500, 14000, '🍳', 'kitchen', ''],
      ['Stainless Pot Set (3 pieces)', 'Cookwise', 32000, 38000, '🥘', 'kitchen', ''],
      ['Chin Chin Snack Box', 'Crunchy Co', 1800, 0, '🍿', 'snacks', ''],
      ['Zobo Hibiscus Drink 1L', 'Mama Pot', 2000, 0, '🥤', 'drinks', ''],
      ['Ground Crayfish 200g', 'Mama Pot', 2600, 0, '🦐', 'spices', ''],
    ],
  },
};

const slugify = (s) => String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'item';

function seed() {
  tx(() => {
    for (const [k, v] of Object.entries(SETTINGS)) run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', k, v);
    if (!get('SELECT 1 x FROM stores LIMIT 1')) {
      STORES.forEach((s, i) => run('INSERT INTO stores (slug,name,tab_label,icon,tagline,hero_title,hero_sub,hero_cta,promo1_title,promo1_sub,promo2_title,promo2_sub,banner_title,banner_sub,sort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ...s, i));
    }
    if (!get('SELECT 1 x FROM zones LIMIT 1')) STATE_ROWS.forEach((z, i) => run('INSERT INTO zones (state,fee,eta,pod,sort) VALUES (?,?,?,?,?)', ...z, i));
    if (get("SELECT value FROM settings WHERE key='demo_seeded'")) return;
    run("INSERT INTO settings (key, value) VALUES ('demo_seeded', '1')");
    if (process.env.SEED_DEMO === '0') return;
    const t = now();
    run("INSERT OR IGNORE INTO coupons (code,type,value,min_spend,max_uses,expires_at,active) VALUES ('WELCOME10','percent',10,10000,0,'',1)");
    for (const [store, data] of Object.entries(CATALOGUE)) {
      const catId = {};
      data.cats.forEach(([slug, name, icon], i) => {
        const r = run('INSERT INTO categories (store,slug,name,icon,sort) VALUES (?,?,?,?,?)', store, `${store}-${slug}`, name, icon, i);
        catId[slug] = Number(r.lastInsertRowid);
      });
      data.products.forEach(([name, brand, price, compare, emoji, cat, variants, sizeLabel], i) => {
        const catName = data.cats.find((c) => c[0] === cat)[1];
        const desc = `${name} by ${brand}. Part of our ${catName.toLowerCase()} range and checked by our team before it ships. We deliver across Nigeria and you can pay online or on delivery in many areas.`;
        const baseStock = 12 + ((i * 7) % 25);
        const r = run('INSERT INTO products (slug,store,category_id,name,brand,description,price,compare_price,stock,sku,emoji,size_label,featured,bestseller,new_arrival,sold,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          `${slugify(name)}-${store.slice(0, 3)}${i + 1}`, store, catId[cat], name, brand, desc, price, compare, variants ? 0 : baseStock,
          `SB-${store.slice(0, 3).toUpperCase()}-${100 + i}`, emoji, sizeLabel || 'Size', 1, i % 2 === 0 ? 1 : 0, i >= 6 ? 1 : 0, (10 - i) * 3, t - i * 3600);
        const pid = Number(r.lastInsertRowid);
        if (variants) {
          const [sz, co] = variants.split('|').map((x) => x.split(',').map((y) => y.trim()).filter(Boolean));
          const sizes = sz && sz.length ? sz : [''], colors = co && co.length ? co : [''];
          let total = 0, j = 0;
          for (const s of sizes) for (const c of colors) { const st = 3 + ((i * 7 + j * 5) % 9); total += st; j++; run('INSERT INTO variants (product_id,size,color,stock) VALUES (?,?,?,?)', pid, s, c, st); }
          run('UPDATE products SET stock=? WHERE id=?', total, pid);
        }
      });
    }
  });
}

module.exports = { seed, slugify, STATE_ROWS, SETTINGS };
void db;
