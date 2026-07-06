import * as THREE from 'three';
import { GLTFLoader } from './lib/GLTFLoader.js';

// ---------------------------------------------------------------- constants
const MARKET_W = 16;           // x: -8 .. 8
const MARKET_D = 12;           // z: -6 .. 6
const HALF_W = MARKET_W / 2;
const HALF_D = MARKET_D / 2;
const PLAYER_R = 0.24;
const WALK_SPEED = 3.1;
const SPRINT_SPEED = 4.7;
const PICK_DIST = 0.95;        // distance to a station to grab
const DELIVER_DIST = 0.8;      // distance to a customer to deliver
const MAX_HEARTS = 3;

// item id -> { file, name, station }
const ITEMS = {
  apple:            { file: 'apple',            name: '사과',        station: 'fruit' },
  banana:           { file: 'banana',           name: '바나나',      station: 'fruit' },
  watermelon:       { file: 'watermelon',       name: '수박',        station: 'fruit' },
  grapes:           { file: 'grapes',           name: '포도',        station: 'fruit' },
  bread:            { file: 'bread',            name: '식빵',        station: 'bakery' },
  croissant:        { file: 'croissant',        name: '크루아상',    station: 'bakery' },
  donut:            { file: 'donut-sprinkles',  name: '도넛',        station: 'bakery' },
  muffin:           { file: 'muffin',           name: '머핀',        station: 'bakery' },
  fish:             { file: 'fish',             name: '생선',        station: 'freezer' },
  popsicle:         { file: 'popsicle',         name: '아이스크림',  station: 'freezer' },
  meat:             { file: 'meat-raw',         name: '생고기',      station: 'freezer' },
  ham:              { file: 'whole-ham',        name: '햄',          station: 'freezer' },
  can:              { file: 'can',              name: '통조림',      station: 'shelf' },
  candy:            { file: 'candy-bar',        name: '초코바',      station: 'shelf' },
  peanutButter:     { file: 'peanut-butter',    name: '땅콩버터',    station: 'shelf' },
  honey:            { file: 'honey',            name: '꿀',          station: 'shelf' },
  soda:             { file: 'soda-bottle',      name: '탄산음료',    station: 'drinks' },
  milk:             { file: 'carton',           name: '우유',        station: 'drinks' },
  wine:             { file: 'wine-red',         name: '와인',        station: 'drinks' },
  cheese:           { file: 'cheese',           name: '치즈',        station: 'drinks' },
};

const STATION_LABEL = {
  fruit: '과일 매대', bakery: '베이커리', freezer: '냉동고',
  shelf: '진열 선반', drinks: '냉장 코너',
};

// ---------------------------------------------------------------- setup
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
const LITE = location.search.includes('lite'); // software-renderer testing
renderer.setPixelRatio(LITE ? 1 : Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = !LITE;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb8e3f5);
scene.fog = new THREE.Fog(0xb8e3f5, 22, 40);

const camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, 0.1, 100);

scene.add(new THREE.HemisphereLight(0xdfefff, 0x9c8a70, 1.0));
const sun = new THREE.DirectionalLight(0xfff3dd, 1.6);
sun.position.set(7, 12, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -12; sun.shadow.camera.right = 12;
sun.shadow.camera.top = 12; sun.shadow.camera.bottom = -12;
sun.shadow.bias = -0.0004;
scene.add(sun);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- audio
const sounds = {};
for (const [key, file] of Object.entries({
  pickup: 'drop_002', deliver: 'confirmation_001', angry: 'error_004',
  gameover: 'bong_001', spawn: 'click_003', combo: 'glass_002',
})) {
  const a = new Audio(`./assets/sounds/${file}.ogg`);
  a.volume = 0.5;
  sounds[key] = a;
}
function play(name) {
  const a = sounds[name];
  if (!a) return;
  a.currentTime = 0;
  a.play().catch(() => {});
}

// ---------------------------------------------------------------- loading
const loader = new GLTFLoader();
const cache = new Map();
function loadGLB(path) {
  if (!cache.has(path)) {
    cache.set(path, new Promise((resolve, reject) => {
      loader.load(path, (g) => {
        g.scene.traverse((o) => {
          if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
        });
        resolve(g);
      }, undefined, reject);
    }));
  }
  return cache.get(path);
}
const market = (n) => loadGLB(`./assets/models/market/${n}.glb`);
const food = (n) => loadGLB(`./assets/models/food/${n}.glb`);
const chars = (n) => loadGLB(`./assets/models/chars/${n}.glb`);

function cloneScene(gltf) {
  return gltf.scene.clone(true);
}

// normalize an object so its bounding box max dimension == size, base at y=0
function normalizeFood(obj, size) {
  const box = new THREE.Box3().setFromObject(obj);
  const dims = new THREE.Vector3(); box.getSize(dims);
  const s = size / Math.max(dims.x, dims.y, dims.z);
  obj.scale.setScalar(s);
  const box2 = new THREE.Box3().setFromObject(obj);
  obj.position.y -= box2.min.y;
  const wrapper = new THREE.Group();
  wrapper.add(obj);
  return wrapper;
}

// ---------------------------------------------------------------- world
const colliders = []; // { minX, maxX, minZ, maxZ }
function addCollider(x, z, w, d) {
  colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
}

const stations = []; // { type, x, z }
function addStation(type, x, z) { stations.push({ type, x, z }); }

async function buildWorld() {
  const worldG = new THREE.Group();
  scene.add(worldG);

  // floor tiles
  const floorG = await market('floor');
  for (let x = -HALF_W + 0.5; x <= HALF_W - 0.5; x++) {
    for (let z = -HALF_D + 0.5; z <= HALF_D - 0.5; z++) {
      const t = cloneScene(floorG);
      t.position.set(x, 0, z);
      worldG.add(t);
    }
  }
  // sidewalk outside the entrance
  const walkMat = new THREE.MeshStandardMaterial({ color: 0xb7b2a6 });
  const walk = new THREE.Mesh(new THREE.BoxGeometry(MARKET_W + 4, 0.04, 4), walkMat);
  walk.position.set(0, 0, HALF_D + 2);
  walk.receiveShadow = true;
  worldG.add(walk);
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x8bc34a });
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), grassMat);
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = -0.01;
  grass.receiveShadow = true;
  worldG.add(grass);

  // perimeter walls (leave a 2-tile door gap on the south side, x in [-1, 1])
  const wallG = await market('wall');
  const wallWinG = await market('wall-window');
  const cornerG = await market('wall-corner');
  const placeWall = (proto, x, z, ry) => {
    const w = cloneScene(proto);
    w.position.set(x, 0, z);
    w.rotation.y = ry;
    worldG.add(w);
  };
  for (let i = 0; i < MARKET_W; i++) {
    const x = -HALF_W + 0.5 + i;
    placeWall(i % 3 === 1 ? wallWinG : wallG, x, -HALF_D + 0.18, 0); // north
    if (x < -1 || x > 1) placeWall(i % 4 === 2 ? wallWinG : wallG, x, HALF_D - 0.18, Math.PI); // south
  }
  for (let i = 0; i < MARKET_D; i++) {
    const z = -HALF_D + 0.5 + i;
    placeWall(i % 3 === 1 ? wallWinG : wallG, -HALF_W + 0.18, z, Math.PI / 2);   // west
    placeWall(i % 3 === 1 ? wallWinG : wallG, HALF_W - 0.18, z, -Math.PI / 2);   // east
  }
  placeWall(cornerG, -HALF_W + 0.18, -HALF_D + 0.18, Math.PI / 2);
  placeWall(cornerG, HALF_W - 0.18, -HALF_D + 0.18, 0);
  placeWall(cornerG, HALF_W - 0.18, HALF_D - 0.18, -Math.PI / 2);
  placeWall(cornerG, -HALF_W + 0.18, HALF_D - 0.18, Math.PI);
  // wall colliders (door gap on south)
  addCollider(0, -HALF_D + 0.2, MARKET_W, 0.6);
  addCollider(-(1.5 + (HALF_W - 1.5) / 2 - 0.75), HALF_D - 0.2, HALF_W - 1.5, 0.6);
  addCollider(1.5 + (HALF_W - 1.5) / 2 - 0.75, HALF_D - 0.2, HALF_W - 1.5, 0.6);
  addCollider(-HALF_W + 0.2, 0, 0.6, MARKET_D);
  addCollider(HALF_W - 0.2, 0, 0.6, MARKET_D);

  // ---- stations ----------------------------------------------------------
  // fruit displays along the west wall
  const fruitG = await market('display-fruit');
  for (let i = 0; i < 3; i++) {
    const s = cloneScene(fruitG);
    s.position.set(-HALF_W + 1.0, 0, -3 + i * 1.6);
    s.rotation.y = Math.PI / 2;
    worldG.add(s);
    addCollider(-HALF_W + 1.0, -3 + i * 1.6, 0.65, 0.65);
    addStation('fruit', -HALF_W + 1.0, -3 + i * 1.6);
  }
  // bakery along the north wall
  const breadG = await market('display-bread');
  for (let i = 0; i < 3; i++) {
    const s = cloneScene(breadG);
    s.position.set(-2.4 + i * 1.7, 0, -HALF_D + 1.0);
    worldG.add(s);
    addCollider(-2.4 + i * 1.7, -HALF_D + 1.0, 0.75, 0.65);
    addStation('bakery', -2.4 + i * 1.7, -HALF_D + 1.0);
  }
  // chest freezers — center-left aisle
  const freezerG = await market('freezer');
  for (let i = 0; i < 3; i++) {
    const s = cloneScene(freezerG);
    s.position.set(-3.4, 0, -1.2 + i * 1.0);
    s.rotation.y = Math.PI / 2;
    worldG.add(s);
    addCollider(-3.4, -1.2 + i * 1.0, 0.65, 0.85);
    addStation('freezer', -3.4, -1.2 + i * 1.0);
  }
  // shelves — center-right aisle
  const shelfBoxG = await market('shelf-boxes');
  const shelfBagG = await market('shelf-bags');
  for (let i = 0; i < 4; i++) {
    const s = cloneScene(i % 2 ? shelfBagG : shelfBoxG);
    s.position.set(2.4, 0, -1.6 + i * 1.0);
    s.rotation.y = Math.PI / 2;
    worldG.add(s);
    addCollider(2.4, -1.6 + i * 1.0, 0.75, 0.85);
    addStation('shelf', 2.4, -1.6 + i * 1.0);
  }
  // standing freezers (drinks) along the east wall
  const standG = await market('freezers-standing');
  for (let i = 0; i < 3; i++) {
    const s = cloneScene(standG);
    s.position.set(HALF_W - 0.85, 0, -2.6 + i * 1.4);
    s.rotation.y = -Math.PI / 2;
    worldG.add(s);
    addCollider(HALF_W - 0.85, -2.6 + i * 1.4, 0.7, 1.05);
    addStation('drinks', HALF_W - 0.85, -2.6 + i * 1.4);
  }

  // ---- decor -------------------------------------------------------------
  const registerG = await market('cash-register');
  const reg = cloneScene(registerG);
  reg.position.set(-5.6, 0, 3.6);
  reg.rotation.y = Math.PI * 0.75;
  worldG.add(reg);
  addCollider(-5.6, 3.6, 0.9, 0.9);

  const cartG = await market('shopping-cart');
  const basketG = await market('shopping-basket');
  const cart1 = cloneScene(cartG); cart1.position.set(6.2, 0, 4.4); cart1.rotation.y = 0.5; worldG.add(cart1);
  addCollider(6.2, 4.4, 0.6, 0.9);
  const cart2 = cloneScene(cartG); cart2.position.set(6.9, 0, 4.6); cart2.rotation.y = 0.35; worldG.add(cart2);
  addCollider(6.9, 4.6, 0.6, 0.9);
  const bk = cloneScene(basketG); bk.position.set(-2.2, 0, 4.9); worldG.add(bk);
  const bottleG = await market('bottle-return');
  const br = cloneScene(bottleG); br.position.set(5.9, 0, -HALF_D + 1.0); worldG.add(br);
  addCollider(5.9, -HALF_D + 1.0, 0.9, 0.7);

  // sample foods on top of the displays (decor)
  const decor = [
    ['apple', -HALF_W + 0.85, -3.25, 0.5], ['banana', -HALF_W + 1.1, -1.35, 0.5],
    ['grapes', -HALF_W + 0.9, -1.55, 0.5], ['watermelon', -HALF_W + 1.0, 0.15, 0.5],
    ['bread', -2.55, -HALF_D + 0.85, 0.48], ['croissant', -2.15, -HALF_D + 1.1, 0.48],
    ['donut-sprinkles', -0.8, -HALF_D + 0.95, 0.48], ['muffin', 0.5, -HALF_D + 1.0, 0.48],
    ['fish', -3.35, -1.15, 0.36], ['popsicle', -3.45, -0.25, 0.36],
    ['whole-ham', -3.4, 0.75, 0.36],
  ];
  for (const [name, x, z, y] of decor) {
    const g = await food(name);
    const obj = normalizeFood(cloneScene(g), 0.28);
    obj.position.set(x, y, z);
    obj.rotation.y = Math.random() * Math.PI * 2;
    worldG.add(obj);
  }
}

// ---------------------------------------------------------------- characters
// useOriginal: skinned models (e.g. character-employee) break with Object3D.clone —
// the clone's meshes stay bound to the original skeleton at the world origin.
// The player is a single instance, so it can use the loaded scene directly.
function makeMixerEntity(gltf, { useOriginal = false } = {}) {
  const obj = useOriginal ? gltf.scene : cloneScene(gltf);
  const mixer = new THREE.AnimationMixer(obj);
  const actions = {};
  for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip);
  return { obj, mixer, actions, current: null };
}
function playAction(ent, name, { loop = true, fade = 0.18 } = {}) {
  const next = ent.actions[name];
  if (!next || ent.current === name) return;
  next.reset();
  next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  next.clampWhenFinished = !loop;
  if (ent.current && ent.actions[ent.current]) next.crossFadeFrom(ent.actions[ent.current], fade, false);
  next.play();
  ent.current = name;
}
function normalizeCharacter(obj, height) {
  // reset first so re-normalizing a reused scene stays idempotent
  obj.scale.setScalar(1);
  obj.position.set(0, 0, 0);
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const dims = new THREE.Vector3(); box.getSize(dims);
  obj.scale.setScalar(height / dims.y);
  obj.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(obj);
  obj.position.y -= box2.min.y;
  const wrapper = new THREE.Group();
  wrapper.add(obj);
  return wrapper;
}

// bubble ring sprite (patience indicator) drawn on a canvas
function makeRingSprite() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 96;
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.setScalar(0.62);
  return { sprite, canvas, tex };
}
function drawRing(ring, frac) {
  const ctx = ring.canvas.getContext('2d');
  const s = ring.canvas.width, c = s / 2, r = s / 2 - 8;
  ctx.clearRect(0, 0, s, s);
  ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.38)'; ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = frac > 0.5 ? '#4caf50' : frac > 0.25 ? '#ff9800' : '#f44336';
  ctx.beginPath();
  ctx.arc(c, c, r - 1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
  ctx.stroke();
  ring.tex.needsUpdate = true;
}

// ---------------------------------------------------------------- game state
const state = {
  running: false,
  score: 0, combo: 0, served: 0, hearts: MAX_HEARTS,
  time: 0, spawnTimer: 2.0,
  carrying: null,          // item id
  carryObj: null,          // THREE object above player head
  customers: [],
  interactCooldown: 0,
};

const keys = {};
const GAME_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight'];
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  // keep arrows/space from scrolling; e.code is IME-independent (works in 한글 mode)
  if (GAME_KEYS.includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k of Object.keys(keys)) keys[k] = false; });

let player = null;            // { group, ent, avatar }
const ALL_SKINS = 'abcdefghijklmnopqr'.split('');
const WAIT_SPOTS = [
  { x: -0.9, z: 2.6 }, { x: 1.1, z: 3.4 }, { x: -2.6, z: 1.6 },
  { x: 3.6, z: 2.2 }, { x: 1.2, z: 0.2 }, { x: -1.6, z: 4.2 },
];
const PLAYER_SPAWN = { x: 0, z: 4.6 };
const DOOR_OUT = { x: 0, z: HALF_D + 2.5 };

// ---- avatar selection ----
const AVATARS = ['employee', ...ALL_SKINS];
let selectedAvatar = localStorage.getItem('md-avatar') || 'employee';
if (!AVATARS.includes(selectedAvatar)) selectedAvatar = 'employee';
{
  const picker = document.getElementById('avatar-picker');
  for (const id of AVATARS) {
    const img = document.createElement('img');
    img.className = 'avatar' + (id === selectedAvatar ? ' selected' : '');
    img.src = `./assets/previews/character-${id === 'employee' ? 'employee' : id}.png`;
    img.title = id === 'employee' ? '마켓 직원' : `캐릭터 ${id.toUpperCase()}`;
    img.addEventListener('click', () => {
      selectedAvatar = id;
      localStorage.setItem('md-avatar', id);
      picker.querySelectorAll('.avatar').forEach((el) => el.classList.remove('selected'));
      img.classList.add('selected');
    });
    picker.appendChild(img);
  }
}
// customers never use the player's skin
function customerSkins() {
  return ALL_SKINS.filter((s) => s !== selectedAvatar);
}

async function makePlayer(avatar) {
  if (player) scene.remove(player.group);
  const g = avatar === 'employee'
    ? await market('character-employee')
    : await chars(`character-${avatar}`);
  const ent = makeMixerEntity(g, { useOriginal: true });
  const group = normalizeCharacter(ent.obj, 0.74);
  group.position.set(PLAYER_SPAWN.x, 0, PLAYER_SPAWN.z);
  // "this is you" marker ring
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.26, 0.36, 32),
    new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  group.add(ring);
  scene.add(group);
  playAction(ent, 'idle');
  player = { group, ent, heading: 0, avatar };
}

let customerSeq = 0;
async function spawnCustomer() {
  const usedSpots = new Set(state.customers.map((c) => c.spot));
  const free = WAIT_SPOTS.map((_, i) => i).filter((i) => !usedSpots.has(i));
  if (free.length === 0) return;
  const spot = free[Math.floor(Math.random() * free.length)];

  const skins = customerSkins();
  const skin = skins[Math.floor(Math.random() * skins.length)];
  const gltf = await chars(`character-${skin}`);
  const ent = makeMixerEntity(gltf);
  const group = normalizeCharacter(ent.obj, 0.74);
  group.position.set((Math.random() - 0.5) * 1.2, 0, HALF_D + 2.2);
  scene.add(group);

  const itemIds = Object.keys(ITEMS);
  const itemId = itemIds[Math.floor(Math.random() * itemIds.length)];

  // request bubble: food model + patience ring
  const bubble = new THREE.Group();
  const ring = makeRingSprite();
  bubble.add(ring.sprite);
  const foodG = await food(ITEMS[itemId].file);
  const foodObj = normalizeFood(cloneScene(foodG), 0.3);
  foodObj.position.y = -0.14;
  foodObj.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  bubble.add(foodObj);
  bubble.position.y = 1.35;
  bubble.visible = false;
  group.add(bubble);

  const patience = Math.max(14, 30 - state.time * 0.06);
  const customer = {
    id: customerSeq++,
    group, ent, spot, itemId, bubble, ring, foodObj,
    phase: 'entering',           // entering -> waiting -> leaving
    patience, patienceLeft: patience,
    happy: false,
    // walk in through the door gap, then to the wait spot
    path: [{ x: 0, z: HALF_D - 0.8 }, { ...WAIT_SPOTS[spot] }],
  };
  playAction(ent, 'walk');
  state.customers.push(customer);
  play('spawn');
}

// ---------------------------------------------------------------- HUD
const $ = (id) => document.getElementById(id);
const hud = {
  score: $('score').querySelector('.value'),
  combo: $('combo').querySelector('.value'),
  served: $('served').querySelector('.value'),
  hearts: $('hearts').querySelector('.value'),
  carry: $('carry'),
  toast: $('toast'),
};
let toastTimer = null;
function toast(msg, ms = 1100) {
  hud.toast.innerHTML = msg;
  hud.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hud.toast.classList.remove('show'), ms);
}
function updateHUD() {
  hud.score.textContent = state.score;
  hud.combo.textContent = `×${state.combo}`;
  hud.served.textContent = state.served;
  hud.hearts.textContent = '❤️'.repeat(state.hearts) + '🖤'.repeat(MAX_HEARTS - state.hearts);
  hud.carry.innerHTML = state.carrying
    ? `🧺 들고 있는 것: <span class="item">${ITEMS[state.carrying].name}</span> — 손님에게 가져가세요! (Q: 내려놓기)`
    : '🧺 빈손 — 손님 말풍선의 물건을 찾아가세요!';
}

// ---------------------------------------------------------------- interactions
async function setCarry(itemId) {
  if (state.carryObj) { player.group.remove(state.carryObj); state.carryObj = null; }
  state.carrying = itemId;
  if (itemId) {
    const g = await food(ITEMS[itemId].file);
    const obj = normalizeFood(cloneScene(g), 0.34);
    obj.position.y = 1.0;
    player.group.add(obj);
    state.carryObj = obj;
  }
  updateHUD();
}

function tryInteract() {
  if (state.interactCooldown > 0) return;
  const p = player.group.position;

  if (!state.carrying) {
    // near a station → grab the item wanted by the longest-waiting matching customer
    for (const st of stations) {
      if (Math.hypot(st.x - p.x, st.z - p.z) > PICK_DIST) continue;
      const wanting = state.customers
        .filter((c) => c.phase === 'waiting' && ITEMS[c.itemId].station === st.type)
        .sort((a, b) => a.patienceLeft - b.patienceLeft);
      if (wanting.length === 0) continue;
      const itemId = wanting[0].itemId;
      setCarry(itemId);
      play('pickup');
      toast(`${ITEMS[itemId].name} 획득! 🏃`);
      playAction(player.ent, 'pick-up', { loop: false, fade: 0.08 });
      player.ent.current = 'pick-up';
      state.interactCooldown = 0.5;
      return;
    }
  } else {
    // near the customer who wants this item → deliver
    for (const c of state.customers) {
      if (c.phase !== 'waiting' || c.itemId !== state.carrying) continue;
      const d = Math.hypot(c.group.position.x - p.x, c.group.position.z - p.z);
      if (d > DELIVER_DIST) continue;
      deliver(c);
      state.interactCooldown = 0.5;
      return;
    }
  }
}

function deliver(c) {
  const bonus = Math.round((c.patienceLeft / c.patience) * 100);
  state.combo += 1;
  const gained = 100 + bonus + state.combo * 20;
  state.score += gained;
  state.served += 1;
  setCarry(null);
  play(state.combo >= 3 ? 'combo' : 'deliver');
  toast(`+${gained}점! ${state.combo >= 2 ? `🔥 콤보 ×${state.combo}` : '😊 감사합니다!'}`);
  c.phase = 'leaving';
  c.happy = true;
  c.bubble.visible = false;
  c.path = [{ x: 0, z: HALF_D - 0.8 }, { ...DOOR_OUT }];
  playAction(c.ent, 'emote-yes', { loop: false });
  c.leaveDelay = 1.0;
  updateHUD();
}

function customerRageQuit(c) {
  state.hearts -= 1;
  state.combo = 0;
  play('angry');
  toast('😡 손님이 화나서 떠났어요!', 1400);
  c.phase = 'leaving';
  c.happy = false;
  c.bubble.visible = false;
  c.path = [{ x: 0, z: HALF_D - 0.8 }, { ...DOOR_OUT }];
  playAction(c.ent, 'emote-no', { loop: false });
  c.leaveDelay = 1.0;
  updateHUD();
  if (state.hearts <= 0) gameOver();
}

// ---------------------------------------------------------------- movement & collision
function moveWithCollision(pos, dx, dz) {
  // x axis
  let nx = pos.x + dx;
  for (const c of colliders) {
    if (nx + PLAYER_R > c.minX && nx - PLAYER_R < c.maxX &&
        pos.z + PLAYER_R > c.minZ && pos.z - PLAYER_R < c.maxZ) {
      nx = dx > 0 ? c.minX - PLAYER_R : c.maxX + PLAYER_R;
    }
  }
  pos.x = THREE.MathUtils.clamp(nx, -HALF_W + 0.55, HALF_W - 0.55);
  // z axis
  let nz = pos.z + dz;
  for (const c of colliders) {
    if (pos.x + PLAYER_R > c.minX && pos.x - PLAYER_R < c.maxX &&
        nz + PLAYER_R > c.minZ && nz - PLAYER_R < c.maxZ) {
      nz = dz > 0 ? c.minZ - PLAYER_R : c.maxZ + PLAYER_R;
    }
  }
  pos.z = THREE.MathUtils.clamp(nz, -HALF_D + 0.55, HALF_D - 0.55);
}

// ---------------------------------------------------------------- game flow
function resetGame() {
  for (const c of state.customers) scene.remove(c.group);
  state.customers.length = 0;
  state.score = 0; state.combo = 0; state.served = 0;
  state.hearts = MAX_HEARTS; state.time = 0; state.spawnTimer = 1.2;
  setCarry(null);
  player.group.position.set(PLAYER_SPAWN.x, 0, PLAYER_SPAWN.z);
  updateHUD();
}
async function startGame() {
  if (!player || player.avatar !== selectedAvatar) await makePlayer(selectedAvatar);
  $('start-screen').classList.add('hidden');
  $('gameover-screen').classList.add('hidden');
  resetGame();
  state.running = true;
}
function gameOver() {
  state.running = false;
  play('gameover');
  $('final-score').textContent = `${state.score}점`;
  $('final-detail').textContent = `손님 ${state.served}명 응대 · ${Math.round(state.time)}초 영업`;
  $('gameover-screen').classList.remove('hidden');
}
$('btn-start').addEventListener('click', startGame);
$('btn-restart').addEventListener('click', startGame);
addEventListener('keydown', (e) => {
  if (e.code === 'KeyQ' && state.running && state.carrying) {
    setCarry(null);
    toast('물건을 내려놓았어요');
  }
  if (e.code === 'Enter') {
    if (!$('start-screen').classList.contains('hidden')) startGame();
    else if (!$('gameover-screen').classList.contains('hidden')) startGame();
  }
});

// ---------------------------------------------------------------- update loop
const clock = new THREE.Clock();
const camTarget = new THREE.Vector3();

function updatePlayer(dt) {
  let mx = 0, mz = 0;
  if (keys.KeyW || keys.ArrowUp) mz -= 1;
  if (keys.KeyS || keys.ArrowDown) mz += 1;
  if (keys.KeyA || keys.ArrowLeft) mx -= 1;
  if (keys.KeyD || keys.ArrowRight) mx += 1;
  const moving = mx !== 0 || mz !== 0;
  const sprint = keys.ShiftLeft || keys.ShiftRight;
  if (moving) {
    const len = Math.hypot(mx, mz);
    const speed = sprint ? SPRINT_SPEED : WALK_SPEED;
    moveWithCollision(player.group.position, (mx / len) * speed * dt, (mz / len) * speed * dt);
    player.heading = Math.atan2(mx, mz);
  }
  // smooth turn
  let d = player.heading - player.group.rotation.y;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  player.group.rotation.y += d * Math.min(1, dt * 14);

  // animation state (let one-shot pick-up finish)
  const act = player.ent.actions[player.ent.current];
  const oneShotPlaying = player.ent.current === 'pick-up' && act && act.isRunning();
  if (!oneShotPlaying) {
    playAction(player.ent, moving ? (sprint ? 'sprint' : 'walk') : 'idle');
  }
  player.ent.mixer.update(dt);

  if (state.carryObj) state.carryObj.rotation.y += dt * 2.2;
}

function updateCustomers(dt) {
  for (let i = state.customers.length - 1; i >= 0; i--) {
    const c = state.customers[i];
    c.ent.mixer.update(dt);

    if (c.phase === 'entering' || c.phase === 'leaving') {
      if (c.leaveDelay && c.leaveDelay > 0) { c.leaveDelay -= dt; continue; }
      if (c.phase === 'leaving' && c.ent.current !== 'walk') playAction(c.ent, 'walk');
      const t = c.path[0];
      const dx = t.x - c.group.position.x, dz = t.z - c.group.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.08) {
        c.path.shift();
        if (c.path.length > 0) continue;
        if (c.phase === 'entering') {
          c.phase = 'waiting';
          c.bubble.visible = true;
          playAction(c.ent, 'idle');
        } else {
          scene.remove(c.group);
          state.customers.splice(i, 1);
        }
        continue;
      }
      const sp = 1.7;
      c.group.position.x += (dx / dist) * sp * dt;
      c.group.position.z += (dz / dist) * sp * dt;
      c.group.rotation.y = Math.atan2(dx, dz);
    } else if (c.phase === 'waiting') {
      c.patienceLeft -= dt;
      // face the player when close
      const p = player.group.position;
      const dx = p.x - c.group.position.x, dz = p.z - c.group.position.z;
      if (Math.hypot(dx, dz) < 2.2) {
        const target = Math.atan2(dx, dz);
        let dr = target - c.group.rotation.y;
        while (dr > Math.PI) dr -= Math.PI * 2;
        while (dr < -Math.PI) dr += Math.PI * 2;
        c.group.rotation.y += dr * Math.min(1, dt * 6);
      }
      c.foodObj.rotation.y += dt * 1.8;
      c.bubble.position.y = 1.35 + Math.sin(state.time * 3 + c.id) * 0.04;
      drawRing(c.ring, Math.max(0, c.patienceLeft / c.patience));
      if (c.patienceLeft <= 0) customerRageQuit(c);
    }
  }
}

function updateSpawning(dt) {
  if (DEBUG) {
    const inner = player.group.children.find((c) => !c.isMesh);
    const wp = new THREE.Vector3();
    let meshWp = 'none';
    player.group.traverse((o) => {
      if (o.isMesh && !o.geometry.isBufferGeometry === false && meshWp === 'none' && o !== player.group.children.find(c=>c.isMesh)) {
        o.getWorldPosition(wp);
        meshWp = `${wp.x.toFixed(1)},${wp.y.toFixed(1)},${wp.z.toFixed(1)}`;
      }
    });
    const ip = inner ? `${inner.position.x.toFixed(1)},${inner.position.y.toFixed(1)},${inner.position.z.toFixed(1)} s:${inner.scale.x.toFixed(2)}` : '?';
    document.title = `grp:${player.group.position.x.toFixed(1)},${player.group.position.z.toFixed(1)} inner:${ip} mesh:${meshWp}`;
  }
  state.spawnTimer -= dt;
  if (state.spawnTimer <= 0) {
    const interval = Math.max(3.5, 9 - state.time * 0.055);
    state.spawnTimer = interval;
    const waiting = state.customers.filter((c) => c.phase !== 'leaving').length;
    if (waiting < 5) spawnCustomer();
  }
}

function updateCamera(dt) {
  const p = player.group.position;
  camTarget.set(
    THREE.MathUtils.clamp(p.x * 0.55, -3.5, 3.5),
    0,
    THREE.MathUtils.clamp(p.z * 0.4, -1.5, 2.0),
  );
  const desired = new THREE.Vector3(camTarget.x, 6.6, camTarget.z + 8.6);
  camera.position.lerp(desired, Math.min(1, dt * 4));
  camera.lookAt(camTarget.x, 0.3, camTarget.z - 0.6);
}

const SIM_STEPS = location.search.includes('sim') ? 30 : 1; // headless testing fast-forward
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (state.running) {
    for (let s = 0; s < SIM_STEPS; s++) {
      const sdt = SIM_STEPS > 1 ? 0.05 : dt;
      state.time += sdt;
      state.interactCooldown = Math.max(0, state.interactCooldown - sdt);
      updatePlayer(sdt);
      updateCustomers(sdt);
      updateSpawning(sdt);
      tryInteract();
    }
  } else if (player) {
    player.ent.mixer.update(dt);
    for (const c of state.customers) c.ent.mixer.update(dt);
  }
  updateCamera(dt);
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- boot
const DEBUG = location.search.includes('debug');
if (DEBUG) {
  addEventListener('error', (e) => { document.title = 'ERR: ' + e.message; });
  addEventListener('unhandledrejection', (e) => { document.title = 'REJ: ' + (e.reason && e.reason.message || e.reason); });
}
(async () => {
  await buildWorld();
  await makePlayer(selectedAvatar);
  camera.position.set(0, 8.2, 9.4);
  camera.lookAt(0, 0.3, 0);
  updateHUD();
  tick();
  if (location.search.includes('auto')) startGame();
  if (location.search.includes('move')) keys.KeyW = keys.KeyA = true; // headless input test
})();
