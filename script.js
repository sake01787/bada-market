const DATA_KEY = 'badaMarketDataV3';
const FAVORITES_KEY = 'badaFavorites';
const PHOTO_DB = 'badaMarketPhotos';

let state = { products: [], bookings: [], comments: [], messages: [] };
let currentUser = null;
let currentRole = '';
let editingId = null;
let previewUrl = '';
let searchText = '';
let gradeFilter = 'all';
let authRole = 'citizen';
let myPageMode = 'citizen';
const ADMIN_UID = 'TMJ63XQhMeheRls0vN34HqZMzDq1';

const $ = selector => document.querySelector(selector);
const isAdmin = () => currentUser?.uid === ADMIN_UID;
const remaining = product => Math.max(0, Number(product.quantity) - Number(product.reserved || 0));
const hasArrivalPassed = product => {
  const arrivalTime = new Date(product?.arrival).getTime();
  return Number.isFinite(arrivalTime) && arrivalTime < Date.now();
};
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
  $('#mypage-screen').classList.toggle('hidden', role !== 'mypage');
  render();
}

window.show = show;
window.toast = toast;

function goHome() {
  currentRole = '';
  document.querySelectorAll('.screen, #login-screen').forEach(element => element.classList.add('hidden'));
  $('#role-screen').classList.remove('hidden');
}

function openMyPage(mode) {
  if (!currentUser) return requireLogin(mode);
  myPageMode = mode;
  show('mypage');
}

function requireLogin(role) {
  if (currentUser) return show(role);
  authRole = role;
  sessionStorage.setItem('badaPendingRole', role);
  $('#role-screen').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  $('#login-title').textContent = role === 'fisher' ? '어민으로 시작하기' : '시민·관광객으로 시작하기';
  $('#login-id').focus();
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
  const localArrival = new Date(arrival.getTime() - arrival.getTimezoneOffset() * 60_000);
  $('#arrival-time').value = localArrival.toISOString().slice(0, 16);
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
        ${renderSellerMessages(product)}
      </div>
      <select class="status-select" onchange="changeStatus('${product.id}', this.value)">
        ${['출항 준비', '조업 중', '입항 예정', '입항 완료'].map(status =>
          `<option ${status === product.status ? 'selected' : ''}>${status}</option>`
        ).join('')}
      </select>
    </article>
  `).join('') || '<p class="empty">아직 등록한 수산물이 없습니다.</p>';
}

function messagesForBooking(bookingId) {
  return state.messages
    .filter(message => message.bookingId === bookingId)
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
}

function renderMessageThread(booking, compact = false) {
  const messages = messagesForBooking(booking.firebaseId);
  return `
    <details class="private-messages" ${compact ? '' : 'open'}>
      <summary>판매자와의 문의 ${messages.length ? `(${messages.length})` : ''}</summary>
      <div class="message-list">
        ${messages.map(message => `<p class="${message.senderId === currentUser?.uid ? 'mine' : ''}"><strong>${escapeHtml(message.senderName)}</strong> ${escapeHtml(message.text)}</p>`).join('') || '<p class="comment-empty">아직 주고받은 메시지가 없어요.</p>'}
      </div>
      <form class="message-form" onsubmit="sendSellerMessage(event, '${booking.firebaseId}')">
        <input name="message" maxlength="300" required placeholder="판매자에게 문의할 내용을 적어 주세요">
        <button type="submit">보내기</button>
      </form>
    </details>
  `;
}

function renderSellerMessages(product) {
  const related = state.messages.filter(message => message.productId === product.id);
  if (!related.length) return '';
  const threads = [...related.reduce((groups, message) => {
    if (!groups.has(message.bookingId)) groups.set(message.bookingId, []);
    groups.get(message.bookingId).push(message);
    return groups;
  }, new Map()).entries()];
  return `
    <details class="private-messages seller-messages">
      <summary>예약자 문의 ${related.length}</summary>
      ${threads.map(([bookingId, messages]) => `
        <div class="seller-thread">
          <div class="message-list">
            ${messages.sort((a, b) => Number(a.createdAt) - Number(b.createdAt)).map(message => `
              <p class="${message.senderId === currentUser?.uid ? 'mine' : ''}"><strong>${escapeHtml(message.senderName)}</strong> ${escapeHtml(message.text)}</p>
            `).join('')}
          </div>
          <form class="message-form" onsubmit="sendSellerMessage(event, '${bookingId}')">
            <input name="message" maxlength="300" required placeholder="예약자에게 답장하기">
            <button type="submit">답장</button>
          </form>
        </div>
      `).join('')}
    </details>
  `;
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
          <p><strong>${escapeHtml(comment.authorName)}</strong> ${escapeHtml(comment.text)}
            ${isAdmin() && comment.firebaseId ? `<button class="admin-delete-comment" type="button" onclick="moderateDeleteComment('${comment.firebaseId}')">관리자 삭제</button>` : ''}
          </p>
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
    if (remaining(product) <= 0 || product.saleStopped || hasArrivalPassed(product)) return false;
    const searchable = [product.name, product.boat, product.pickup, product.grade, product.status, product.unit]
      .join(' ')
      .toLocaleLowerCase('ko-KR');
    const matchesSearch = !normalized || searchable.includes(normalized);
    const matchesGrade = gradeFilter === 'all' || product.grade === gradeFilter;
    return matchesSearch && matchesGrade;
  });

  $('#product-count').textContent = `${products.length}개 품목`;
  $('#citizen-list').innerHTML = products.map(product => {
    const isMine = product.ownerId === currentUser?.uid;
    const liked = state.favorites?.includes(product.id);
    const statusClass = ({ '출항 준비': 'ready', '조업 중': 'fishing', '입항 예정': 'expected', '입항 완료': 'completed' })[product.status] || 'ready';
    return `
      <article class="product-card">
        <button type="button" class="favorite-btn" onclick="toggleFavorite('${product.id}')">${liked ? '♥ 관심 상품' : '♡ 관심 상품'}</button>
        ${productPhoto(product, 'product-photo')}
        <span class="boat">⚓ 어선 ${escapeHtml(product.boat)}</span>
        <span class="arrival-status ${statusClass}"><i></i>${escapeHtml(product.status || '입항 상태 확인 중')}</span>
        <p class="arrival-time">⏱ 예상 입항: <b>${formatTime(product.arrival)}</b></p>
        <h4>${escapeHtml(product.name)}</h4>
        <span class="tag ${product.grade === '못난이' ? 'ugly' : ''}">${escapeHtml(product.grade)} 수산물</span>
        ${isMine ? '<p class="owner-badge">내가 등록한 상품</p>' : ''}
        ${isAdmin() ? `<button class="admin-hide-product" type="button" onclick="moderateHideProduct('${product.id}')">관리자 · 상품 숨김</button>` : ''}
        <p class="price">${Number(product.price).toLocaleString('ko-KR')}원 <small>/ ${escapeHtml(product.unit)}</small></p>
        <p class="stock">남은 수량 <b>${remaining(product)}${escapeHtml(product.unit)}</b></p>
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
  const activeBookings = state.bookings.filter(booking => booking.bookingStatus !== 'cancelled');
  $('#booking-list').innerHTML = activeBookings.map(booking => {
    const product = state.products.find(item => item.id === booking.productId);
    const status = product?.status || booking.status || '판매 정보 없음';
    const pickup = product?.pickup || booking.pickup;
    const saleStopped = Boolean(product?.saleStopped);
    return `
      <article class="booking-item">
        ${productPhoto(product || booking, 'booking-photo')}
        <div class="item-main">
          <strong>${escapeHtml(booking.name)} ${booking.qty}${escapeHtml(booking.unit)} 예약</strong>
          <small>${escapeHtml(booking.boat)} · ${escapeHtml(status)}</small>
          <small>📍 픽업 장소: ${escapeHtml(pickup)}</small>
          <small>${canCancel(booking) ? '예상 입항 1시간 전까지 취소 가능' : '예약 취소 가능 시간이 지났습니다.'}</small>
          ${saleStopped ? '<p class="sale-warning">⚠️ 예약한 물품이 판매중단 되었어요.<br>판매자에게 메시지로 물어보세요.</p>' : ''}
          ${saleStopped ? renderMessageThread(booking) : ''}
        </div>
        <button type="button" class="cancel-booking" onclick="cancelBooking('${booking.firebaseId}')" ${canCancel(booking) ? '' : 'disabled'}>예약 취소</button>
      </article>
    `;
  }).join('') || '<p class="empty">아직 예약한 수산물이 없어요.</p>';
}

function bookingProduct(booking) {
  return state.products.find(product => product.id === booking.productId);
}

function bookingIsCompleted(booking) {
  const product = bookingProduct(booking);
  return product?.status === '입항 완료' || booking.productStatus === '입항 완료';
}

function renderMyBooking(booking, type) {
  const product = bookingProduct(booking);
  const statusText = type === 'cancelled'
    ? '예약 취소'
    : type === 'completed'
      ? '입항 완료'
      : '픽업 예정';
  const dateText = type === 'cancelled' && booking.cancelledAt
    ? `취소일 ${formatTime(booking.cancelledAt)}`
    : product?.arrival || booking.arrival
      ? `입항 ${formatTime(product?.arrival || booking.arrival)}`
      : '입항 시간 확인 중';
  return `
    <article class="mypage-item booking-${type}">
      ${productPhoto(product || booking, 'booking-photo')}
      <div class="item-main">
        <strong>${escapeHtml(booking.name)} <span class="mypage-status ${type}">${statusText}</span></strong>
        <small>${escapeHtml(booking.boat)} · ${escapeHtml(booking.qty)}${escapeHtml(booking.unit)}</small>
        <small>${dateText}</small>
        <small>📍 ${escapeHtml(product?.pickup || booking.pickup || '픽업 장소 확인 중')}</small>
      </div>
    </article>
  `;
}

function renderMyProduct(product, type) {
  const statusText = type === 'reserved'
    ? `예약 ${product.reserved || 0}${escapeHtml(product.unit)}`
    : type === 'completed'
      ? '입항 완료'
      : '판매 중';
  return `
    <article class="mypage-item product-${type}">
      ${productPhoto(product, 'booking-photo')}
      <div class="item-main">
        <strong>${escapeHtml(product.name)} <span class="mypage-status ${type}">${statusText}</span></strong>
        <small>${escapeHtml(product.boat)} · ${Number(product.price).toLocaleString('ko-KR')}원/${escapeHtml(product.unit)}</small>
        <small>${formatTime(product.arrival)} · 남은 수량 ${remaining(product)}${escapeHtml(product.unit)}</small>
        <small>📍 ${escapeHtml(product.pickup)}</small>
      </div>
    </article>
  `;
}

function renderMySection(title, eyebrow, items, empty, renderer) {
  return `
    <section class="panel mypage-panel">
      <div class="section-heading"><div><span class="eyebrow">${eyebrow}</span><h3>${title}</h3></div><span class="count-badge">${items.length}</span></div>
      <div class="item-list">${items.map(renderer).join('') || `<p class="empty">${empty}</p>`}</div>
    </section>
  `;
}

function renderMyPage() {
  const isFisher = myPageMode === 'fisher';
  $('#mypage-title').textContent = isFisher ? '어민 MY 페이지' : 'MY 페이지';
  $('#mypage-role-label').textContent = isFisher ? '어민 판매 관리' : '시민 · 관광객 구매 관리';
  $('#mypage-user-name').textContent = currentUser?.displayName || '로그인해 주세요';
  $('#mypage-user-email').textContent = currentUser?.email || '';
  $('#mypage-go-market').textContent = isFisher ? '판매 관리' : '장터로';

  if (isFisher) {
    const mine = state.products.filter(product => product.ownerId === currentUser?.uid);
    const selling = mine.filter(product => product.status !== '입항 완료' && !product.saleStopped);
    const reserved = mine.filter(product => product.status !== '입항 완료' && Number(product.reserved || 0) > 0);
    const completed = mine.filter(product => product.status === '입항 완료');
    $('#mypage-summary').innerHTML = `
      <div class="mypage-metric"><small>판매 중</small><b>${selling.length}</b></div>
      <div class="mypage-metric"><small>예약 상품</small><b>${reserved.length}</b></div>
      <div class="mypage-metric"><small>거래 완료</small><b>${completed.length}</b></div>
    `;
    $('#mypage-sections').innerHTML = [
      renderMySection('판매 중인 상품', '판매 관리', selling, '현재 판매 중인 상품이 없습니다.', product => renderMyProduct(product, 'selling')),
      renderMySection('예약이 있는 상품', '예약 현황', reserved, '예약이 접수된 상품이 없습니다.', product => renderMyProduct(product, 'reserved')),
      renderMySection('거래 완료한 상품', '판매 이력', completed, '입항 완료된 상품이 없습니다.', product => renderMyProduct(product, 'completed'))
    ].join('');
    return;
  }

  const bookings = state.bookings.filter(booking => booking.buyerId === currentUser?.uid);
  const upcoming = bookings.filter(booking => booking.bookingStatus !== 'cancelled' && !bookingIsCompleted(booking));
  const purchased = bookings.filter(booking => booking.bookingStatus !== 'cancelled' && bookingIsCompleted(booking));
  const cancelled = bookings.filter(booking => booking.bookingStatus === 'cancelled');
  const favorites = state.products.filter(product => state.favorites?.includes(product.id));
  $('#mypage-summary').innerHTML = `
    <div class="mypage-metric"><small>픽업 예정</small><b>${upcoming.length}</b></div>
    <div class="mypage-metric"><small>구매 내역</small><b>${purchased.length}</b></div>
    <div class="mypage-metric"><small>관심 상품</small><b>${favorites.length}</b></div>
  `;
  $('#mypage-sections').innerHTML = [
    renderMySection('예정된 픽업 예약', '내 예약', upcoming, '예정된 픽업 예약이 없습니다.', booking => renderMyBooking(booking, 'upcoming')),
    renderMySection('구매 내역', '입항 완료', purchased, '입항 완료된 구매 내역이 없습니다.', booking => renderMyBooking(booking, 'completed')),
    renderMySection('취소한 상품', '예약 취소', cancelled, '취소한 예약이 없습니다.', booking => renderMyBooking(booking, 'cancelled')),
    renderMySection('찜한 상품', '관심 상품', favorites, '찜한 상품이 없습니다.', product => renderMyProduct(product, 'favorite'))
  ].join('');
}

function renderFavorites() {
  $('#favorites-panel')?.remove();
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
  renderMyPage();
  hydratePhotos();
}

window.badaApplyData = (data, user) => {
  state = {
    products: data.products || [],
    bookings: data.bookings || [],
    comments: data.comments || [],
    messages: data.messages || [],
    favorites: data.favorites || []
  };
  currentUser = user;
  localStorage.setItem(DATA_KEY, JSON.stringify({ products: state.products, bookings: state.bookings }));
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(state.favorites));
  render();
};

window.badaSignedOut = () => {
  state = { products: [], bookings: [], comments: [], messages: [], favorites: [] };
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
window.moderateDeleteComment = id => window.badaApi?.deleteCommentAsAdmin(id);
window.moderateHideProduct = id => window.badaApi?.hideProductAsAdmin(id);
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
window.sendSellerMessage = (event, bookingId) => {
  event.preventDefault();
  const input = event.currentTarget.elements.message;
  window.badaApi?.sendMessage(bookingId, input.value.trim());
  input.value = '';
};
document.querySelectorAll('[data-start]').forEach(button => {
  button.addEventListener('click', () => requireLogin(button.dataset.start));
});
document.querySelectorAll('[data-role]').forEach(button => {
  button.addEventListener('click', () => currentUser ? show(button.dataset.role) : requireLogin(button.dataset.role));
});
document.querySelectorAll('[data-mypage]').forEach(button => {
  button.addEventListener('click', () => openMyPage(button.dataset.mypage));
});
document.querySelectorAll('[data-home]').forEach(button => button.addEventListener('click', goHome));
document.querySelectorAll('[data-logout]').forEach(button => {
  button.addEventListener('click', () => window.badaApi?.logout());
});
$('#mypage-back').addEventListener('click', () => currentUser && show(myPageMode));
$('#mypage-go-market').addEventListener('click', () => currentUser && show(myPageMode));
$('#change-user').addEventListener('click', () => window.badaApi?.logout());
$('#clear-bookings')?.remove();
$('#cancel-edit').addEventListener('click', resetForm);
function selectAuthMode(mode) {
  const signup = mode === 'signup';
  $('#login-tab').classList.toggle('active', !signup);
  $('#signup-tab').classList.toggle('active', signup);
  $('#email-login-form').classList.toggle('hidden', signup);
  $('#email-signup-form').classList.toggle('hidden', !signup);
  (signup ? $('#signup-id') : $('#login-id')).focus();
}

$('#login-tab').addEventListener('click', () => selectAuthMode('login'));
$('#signup-tab').addEventListener('click', () => selectAuthMode('signup'));
$('#login-cancel').addEventListener('click', goHome);
$('#google-login').addEventListener('click', () => window.badaApi?.loginWithGoogle(authRole));

$('#email-login-form').addEventListener('submit', async event => {
  event.preventDefault();
  await window.badaApi?.loginWithEmail(
    $('#login-id').value.trim(),
    $('#login-password').value,
    authRole
  );
});

$('#email-signup-form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('#signup-password').value;
  if (password !== $('#signup-password-confirm').value) return toast('비밀번호 확인이 일치하지 않아요.');
  await window.badaApi?.registerWithEmail(
    $('#signup-id').value.trim(),
    password,
    authRole
  );
});

$('#reset-password')?.addEventListener('click', async () => {
  const identifier = $('#login-id').value.trim();
  if (!identifier) return toast('비밀번호를 재설정할 아이디를 입력해 주세요.');
  await window.badaApi?.resetPassword(identifier);
});

document.querySelectorAll('[data-password-toggle]').forEach(button => {
  button.addEventListener('click', () => {
    const input = $(`#${button.dataset.passwordToggle}`);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    button.textContent = showing ? '보기' : '숨기기';
    button.setAttribute('aria-label', showing ? '비밀번호 보기' : '비밀번호 숨기기');
  });
});

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
    <small class="search-help">수산물명, 어선명, 픽업 장소로 검색할 수 있어요.</small>
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
document.querySelectorAll('[data-grade-filter]').forEach(button => {
  button.addEventListener('click', () => {
    gradeFilter = button.dataset.gradeFilter;
    document.querySelectorAll('[data-grade-filter]').forEach(item => item.classList.toggle('active', item === button));
    renderCitizenList();
    hydratePhotos();
  });
});
resetForm();
render();
