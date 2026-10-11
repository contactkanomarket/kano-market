// Nigerian banks with their Paystack bank codes. Used so the bank picker works
// instantly (and offline); the live Paystack list replaces it when it loads,
// and the server always re-checks the code before saving.

export interface Bank {
  name: string;
  code: string;
}

export const NIGERIAN_BANKS: Bank[] = [
  { name: "Access Bank", code: "044" },
  { name: "Access Bank (Diamond)", code: "063" },
  { name: "Carbon", code: "565" },
  { name: "Citibank Nigeria", code: "023" },
  { name: "Ecobank Nigeria", code: "050" },
  { name: "FairMoney Microfinance Bank", code: "51318" },
  { name: "Fidelity Bank", code: "070" },
  { name: "First Bank of Nigeria", code: "011" },
  { name: "First City Monument Bank", code: "214" },
  { name: "Globus Bank", code: "00103" },
  { name: "Guaranty Trust Bank", code: "058" },
  { name: "Jaiz Bank", code: "301" },
  { name: "Keystone Bank", code: "082" },
  { name: "Kuda Bank", code: "50211" },
  { name: "Lotus Bank", code: "303" },
  { name: "Moniepoint Microfinance Bank", code: "50515" },
  { name: "OPay Digital Services Limited (OPay)", code: "999992" },
  { name: "Optimus Bank", code: "107" },
  { name: "PalmPay", code: "999991" },
  { name: "Parallex Bank", code: "104" },
  { name: "Polaris Bank", code: "076" },
  { name: "PremiumTrust Bank", code: "105" },
  { name: "Providus Bank", code: "101" },
  { name: "Signature Bank", code: "106" },
  { name: "Stanbic IBTC Bank", code: "221" },
  { name: "Standard Chartered Bank", code: "068" },
  { name: "Sterling Bank", code: "232" },
  { name: "SunTrust Bank", code: "100" },
  { name: "TAJ Bank", code: "302" },
  { name: "Titan Trust Bank", code: "102" },
  { name: "Union Bank of Nigeria", code: "032" },
  { name: "United Bank For Africa", code: "033" },
  { name: "Unity Bank", code: "215" },
  { name: "VFD Microfinance Bank", code: "566" },
  { name: "Wema Bank", code: "035" },
  { name: "Zenith Bank", code: "057" },
];

/** Short names people actually type ("gtb", "uba", "first bank"...). */
export const BANK_ALIASES: Record<string, string> = {
  "058": "gtb gtbank gt bank guaranty",
  "033": "uba",
  "011": "firstbank first bank fbn",
  "214": "fcmb",
  "057": "zenith",
  "044": "access",
  "999992": "opay",
  "999991": "palmpay palm pay",
  "50515": "moniepoint monie point",
  "035": "wema alat",
  "232": "sterling",
  "221": "stanbic ibtc",
};
