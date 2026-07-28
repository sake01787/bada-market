const DATA_KEY = 'badaMarketDataV3';
const FAVORITES_KEY = 'badaFavorites';
const PHOTO_DB = 'badaMarketPhotos';

let state = { products: [], bookings: [], comments: [] };
let currentUser = null;
let currentRole = '';
let editingId = null;
let previewUrl = '';
let searchText = '';

const $ = selector => document.querySelector(selector);
const remaining = product => Math.max(0, Number(product.quantity) - Number(product.reserved || 0));
const formatTime = value => new Date(value).toLocaleString('ko-KR', {
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
});

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 2600);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[character]);
}

function photoDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PHOTO_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('photos');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getPhoto(id) {
  const db = await photoDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction('photos').objectStore('photos').get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function hydratePhotos() {
  for (const element of document.querySelectorAll('[data-photo-id]')) {
    try {
      const blob = await getPhoto(element.dataset.photoId);
      if (blob) element.src = URL.createObjectURL(blob);
    } catch (error) {
      console.warn('사진 표시 실패', error);
    }
  }
}

function show(role) {
  currentRole = role;
  $('#role-screen').classList.add('hidden');
  $('#login-screen').classList.add('hidden');
  $('#fisher-screen').classList.toggle('hidden', role !== 'fisher');
  $('#citizen-screen').classList.toggle('hidden', role !== 'citizen');
  render();
}

window.show = show;
window.toast = toast;

function goHome() {
  currentRole = '';
  document.querySelectorAll('.screen, #login-screen').forEach(element => element.classList.add('hidden'));
  $('#role-screen').classList.remove('hidden');
}

function requireLogin(role) {
  if (window.badaApi?.login) return window.badaApi.login(role);
  toast('로그인 기능을 준비하고 있어요. 잠시 후 다시 눌러 주세요.');
}

function resetForm() {
  editingId = null;
  $('#catch-form').reset();
  $('#form-title').textContent = '입항 수산물 등록';
  $('#submit-product').textContent = '수산물 등록하기';
  $('#cancel-edit').classList.add('hidden');
  $('#photo-preview').classList.add('hidden');
  $('#price-unit').textContent = 'kg';
  $('#quantity-unit').textContent = 'kg';
  const arrival = new Date();
  arrival.setHours(arrival.getHours() + 3);
  $('#arrival-time').value = arrival.toISOString().slice(0, 16);
}

function productPhoto(product, className) {
  return product.photoId
    ? `<img class="${className}" data-photo-id="${escapeHtml(product.photoId)}" alt="${escapeHtml(product.name)} 사진">`
    : '<div class="fish-dot">🐟</div>';
}

function renderFisherList() {
  const mine = state.products.filter(product => product.ownerId === currentUser?.uid);
  $('#fisher-list').innerHTML = mine.map(product => `
    <article class="catch-item">
      ${productPhoto(product, 'item-photo')}
      <div class="item-main">
        <strong>${escapeHtml(product.name)}
          <span class="tag ${product.grade === '못난이' ? 'ugly' : ''}">${escapeHtml(product.grade)}</span>
        </strong>
        <small>${escapeHtml(product.boat)} · ${formatTime(product.arrival)} · 예약 ${product.reserved || 0}/${product.quantity}${escapeHtml(product.unit)}</small>
        <small>📍 ${escapeHtml(product.pickup)}</small>
        <small class="owner-badge">내가 등록한 상품</small>
        <div class="product-actions">
          <button type="button" onclick="editProduct('${product.id}')">수정</button>
          <button type="button" class="delete" onclick="deleteProduct('${product.id}')">삭제</button>
          <button type="button" class="stop-btn" onclick="toggleSale('${product.id}')">${product.saleStopped ? '판매 재개' : '판매 중단'}</button>
        </div>
      </div>
      <select class="status-select" onchange="changeStatus('${product.id}', this.value)">
        ${['출항 준비', '조업 중', '입항 예정', '입항 완료'].map(status =>
          `<option ${status === product.status ? 'selected' : ''}>${status}</option>`
        ).join('')}
      </select>
    </article>
  `).join('') || '<p class="empty">아직 등록한 수산물이 없습니다.</p>';
}

function commentsFor(productId) {
  return state.comments
    .filter(comment => comment.productId === productId)
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
}

function renderComments(product) {
  const comments = commentsFor(product.id);
  return `
    <details class="comments">
      <summary>댓글로 문의하기 ${comments.length ? `(${comments.length})` : ''}</summary>
      <div class="comment-list">
        ${comments.map(comment => `
          <p><strong>${escapeHtml(comment.authorName)}</strong> ${escapeHtml(comment.text)}</p>
        `).join('') || '<p class="comment-empty">아직 댓글이 없어요.</p>'}
      </div>
      <form class="comment-form" onsubmit="submitComment(event, '${product.id}')">
        <input name="comment" maxlength="200" required placeholder="판매자에게 문의할 내용을 적어 주세요">
        <button type="submit">등록</button>
      </form>
    </details>
  `;
}

function renderCitizenList() {
  const normalized = searchText.trim().toLocaleLowerCase('ko-KR');
  const products = state.products.filter(product => {
    if (remaining(product) <= 0 || product.saleStopped) return false;
    const searchable = [product.name, product.boat, product.pickup, product.grade, product.status, product.unit]
      .join(' ')
      .toLocaleLowerCase('ko-KR');
    return !normalized || searchable.includes(normalized);
  });

  $('#product-count').textContent = `${products.length}개 품목`;
  $('#citizen-list').innerHTML = products.map(product => {
    const isMine = product.ownerId === currentUser?.uid;
    const liked = state.favorites?.includes(product.id);
    return `
      <article class="product-card">
        <button type="button" class="favorite-btn" onclick="toggleFavorite('${product.id}')">${liked ? '♥ 관심 상품' : '♡ 관심 상품'}</button>
        ${productPhoto(product, 'product-photo')}
        <span class="boat">⚓ ${escapeHtml(product.boat)} · ${formatTime(product.arrival)}</span>
        <h4>${escapeHtml(product.name)}</h4>
        <span class="tag ${product.grade === '못난이' ? 'ugly' : ''}">${escapeHtml(product.grade)} 수산물</span>
        ${isMine ? '<p class="owner-badge">내가 등록한 상품</p>' : ''}
        <p class="price">${Number(product.price).toLocaleString('ko-KR')}원 <small>/ ${escapeHtml(product.unit)}</small></p>
        <p class="stock">${escapeHtml(product.status)} · 남은 수량 <b>${remaining(product)}${escapeHtml(product.unit)}</b></p>
        <p class="pickup">📍 픽업: ${escapeHtml(product.pickup)}</p>
        <div class="reserve-row">
          <input id="qty-${product.id}" type="number" min="1" max="${remaining(product)}" value="1" ${isMine ? 'disabled' : ''}>
          <button type="button" onclick="reserve('${product.id}')" ${isMine ? 'disabled' : ''}>${isMine ? '내 상품' : '예약하기'}</button>
        </div>
        ${renderComments(product)}
      </article>
    `;
  }).join('') || `<p class="empty">${normalized ? '검색 조건에 맞는 수산물이 없습니다.' : '현재 예약 가능한 수산물이 없습니다.'}</p>`;
}

function canCancel(booking) {
  const product = state.products.find(item => item.id === booking.productId);
  if (!product) return false;
  return Date.now() <= new Date(product.arrival).getTime() - 60 * 60 * 1000;
}

function renderBookings() {
  $('#booking-list').innerHTML = state.bookings.map(booking => {
    const product = state.products.find(item => item.id === booking.productId);
    const status = product?.status || booking.status || '판매 정보 없음';
    const pickup = product?.pickup || booking.pickup;
    return `
      <article class="booking-item">
        ${productPhoto(product || booking, 'booking-photo')}
        <div class="item-main">
          <strong>${escapeHtml(booking.name)} ${booking.qty}${escapeHtml(booking.unit)} 예약</strong>
          <small>${escapeHtml(booking.boat)} · ${escapeHtml(status)}</small>
          <small>📍 픽업 장소: ${escapeHtml(pickup)}</small>
          <small>${canCancel(booking) ? '예상 입항 1시간 전까지 취소 가능' : '예약 취소 가능 시간이 지났습니다.'}</small>
        </div>
        <button type="button" class="cancel-booking" onclick="cancelBooking('${booking.firebaseId}')" ${canCancel(booking) ? '' : 'disabled'}>예약 취소</button>
      </article>
    `;
  }).join('') || '<p class="empty">아직 예약한 수산물이 없어요.</p>';
}

function renderFavorites() {
  let panel = $('#favorites-panel');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'favorites-panel';
    panel.className = 'panel bookings';
    $('.citizen-content').append(panel);
  }
  const favorites = state.products.filter(product => state.favorites?.includes(product.id));
  panel.innerHTML = `
    <div class="section-heading"><div><span class="eyebrow">마이페이지</span><h3>관심 상품</h3></div></div>
    ${favorites.map(product => `
      <div class="booking-item">
        ${productPhoto(product, 'booking-photo')}
        <div class="item-main"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.boat)} · ${Number(product.price).toLocaleString('ko-KR')}원/${escapeHtml(product.unit)}</small></div>
      </div>
    `).join('') || '<p class="empty">관심 상품이 없습니다.</p>'}
  `;
}

function render() {
  document.querySelectorAll('.user-name').forEach(element => {
    element.textContent = currentUser?.displayName || '로그인 필요';
  });
  $('#current-user-label').textContent = currentUser ? `${currentUser.displayName}님의 예약` : '로그인해 주세요';
  renderFisherList();
  renderCitizenList();
  renderBookings();
  renderFavorites();
  hydratePhotos();
}

window.badaApplyData = (data, user) => {
  state = {
    products: data.products || [],
    bookings: data.bookings || [],
    comments: data.comments || [],
    favorites: data.favorites || []
  };
  currentUser = user;
  localStorage.setItem(DATA_KEY, JSON.stringify({ products: state.products, bookings: state.bookings }));
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(state.favorites));
  render();
};

window.badaSignedOut = () => {
  state = { products: [], bookings: [], comments: [], favorites: [] };
  currentUser = null;
  goHome();
  render();
};

window.editProduct = id => {
  const product = state.products.find(item => item.id === id);
  if (!product || product.ownerId !== currentUser?.uid) return toast('내 상품만 수정할 수 있어요.');
  editingId = id;
  $('#boat-name').value = product.boat;
  $('#product-name').value = product.name;
  $('#product-grade').value = product.grade;
  $('#product-unit').value = product.unit;
  $('#product-price').value = product.price;
  $('#product-qty').value = product.quantity;
  $('#pickup-location').value = product.pickup;
  $('#arrival-time').value = product.arrival;
  $('#arrival-status').value = product.status;
  $('#price-unit').textContent = product.unit;
  $('#quantity-unit').textContent = product.unit;
  $('#form-title').textContent = '수산물 정보 수정';
  $('#submit-product').textContent = '수정 저장하기';
  $('#cancel-edit').classList.remove('hidden');
  $('.form-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.deleteProduct = id => window.badaApi?.deleteProduct(id);
window.changeStatus = (id, status) => window.badaApi?.updateProduct(id, { status });
window.toggleSale = id => {
  const product = state.products.find(item => item.id === id);
  if (product) window.badaApi?.updateProduct(id, { saleStopped: !product.saleStopped });
};
window.reserve = id => {
  const quantity = Number($(`#qty-${id}`)?.value || 0);
  window.badaApi?.reserve(id, quantity);
};
window.cancelBooking = id => window.badaApi?.cancelBooking(id);
window.toggleFavorite = id => window.badaApi?.toggleFavorite(id);
window.submitComment = (event, productId) => {
  event.preventDefault();
  const input = event.currentTarget.elements.comment;
  window.badaApi?.addComment(productId, input.value.trim());
  input.value = '';
};

document.querySelectorAll('[data-start]').forEach(button => {
  button.addEventListener('click', () => requireLogin(button.dataset.start));
});
document.querySelectorAll('[data-role]').forEach(button => {
  button.addEventListener('click', () => currentUser ? show(button.dataset.role) : requireLogin(button.dataset.role));
});
document.querySelectorAll('[data-home]').forEach(button => button.addEventListener('click', goHome));
document.querySelectorAll('[data-logout]').forEach(button => {
  button.addEventListener('click', () => window.badaApi?.logout());
});
$('#change-user').addEventListener('click', () => window.badaApi?.logout());
$('#clear-bookings')?.remove();
$('#cancel-edit').addEventListener('click', resetForm);

$('#product-unit').addEventListener('change', event => {
  $('#price-unit').textContent = event.target.value;
  $('#quantity-unit').textContent = event.target.value;
});

$('#product-photo').addEventListener('change', event => {
  const file = event.target.files[0];
  if (!file) return;
  URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  $('#photo-preview').src = previewUrl;
  $('#photo-preview').classList.remove('hidden');
});

$('#catch-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentUser) return requireLogin('fisher');
  const product = {
    id: editingId || crypto.randomUUID(),
    boat: $('#boat-name').value.trim(),
    name: $('#product-name').value.trim(),
    grade: $('#product-grade').value,
    unit: $('#product-unit').value,
    price: Number($('#product-price').value),
    quantity: Number($('#product-qty').value),
    pickup: $('#pickup-location').value.trim(),
    arrival: $('#arrival-time').value,
    status: $('#arrival-status').value
  };
  const photo = $('#product-photo').files[0] || null;
  await window.badaApi?.saveProduct(product, photo, Boolean(editingId));
  resetForm();
});

function installSearch() {
  const heading = $('.citizen-content > .section-heading');
  const panel = document.createElement('section');
  panel.className = 'panel search-panel';
  panel.setAttribute('role', 'search');
  panel.innerHTML = `
    <label for="product-search">수산물 검색</label>
    <div class="search-row">
      <input id="product-search" type="search" autocomplete="off" enterkeyhint="search" placeholder="수산물명, 어선명, 픽업 장소 검색">
      <button id="product-search-clear" class="search-clear" type="button">지우기</button>
    </div>
    <small class="search-help">일반·못난이, 입항 상태, 판매 단위로도 검색할 수 있어요.</small>
  `;
  heading.before(panel);
  $('#product-search').addEventListener('input', event => {
    searchText = event.target.value;
    renderCitizenList();
    hydratePhotos();
  });
  $('#product-search-clear').addEventListener('click', () => {
    $('#product-search').value = '';
    searchText = '';
    renderCitizenList();
    hydratePhotos();
  });
}

installSearch();
resetForm();
render();
