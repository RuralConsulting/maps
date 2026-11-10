// Public settings for the portal. The anon key is designed to be public: it can only
// do what the database security rules allow (read your own farms, nothing else).
// NEVER put the service_role (secret) key here.
window.RCL_PORTAL = {
  supabaseUrl: "https://wmdhruwkcgtytojlmrkl.supabase.co",
  supabaseAnonKey: "sb_publishable__Zr9HEyQWWtUCVOpYKnCrw_VPAx-CSs",
  // Optional: a LINZ Basemaps API key (basemaps.linz.govt.nz) makes the 3D view use LINZ elevation, LiDAR where
  // flown. Without one, 3D uses free terrain tiles (in NZ made from the LINZ 8 m DEM). Browser keys are public.
  linzKey: "",
};
