import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBn_YDDBb6wHksyLiJeB7GVtpoZ0rlpA3Y',
  authDomain: 'bada-market-24964.firebaseapp.com',
  projectId: 'bada-market-24964',
  storageBucket: 'bada-market-24964.firebasestorage.app',
  messagingSenderId: '951269968414',
  appId: '1:951269968414:web:53874eb4c2b44131333c0f'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const ADMIN_UID = 'BIfYwrOXNLR8J8SkzbJyeSByNHN2';
let activeUser = null;
let syncing = false;

const displayName = user => user?.displayName || user?.email?.split('@')[0] || '바다장터 사용자';

function notice(message) {
  if (typeof window.toast === 'function') window.toast(message);
  else alert(message);
}

function dataUrlToBlob(dataUrl) {
  const [header, encoded] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
  const bytes = atob(encoded);
  const array = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index++) array[index] = bytes.charCodeAt(index);
  return new Blob([array], { type: mime });
}

function putLocalPhoto(id, blob) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('badaMarketPhotos', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('photos');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction('photos', 'readwrite');
      transaction.objectStore('photos').put(blob, id);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

async function compressPhoto(file) {
  if (!file) return '';
  const bitmap = await createImageBitmap(file);
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let quality = 0.8;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  while (dataUrl.length > 560000 && quality > 0.4) {
    quality -= 0.08;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }
  if (dataUrl.length > 700000) {
    throw new Error('사진을 충분히 압축하지 못했어요. 다른 사진을 선택해 주세요.');
  }
  return dataUrl;
}

async function sync() {
  if (!activeUser || syncing) return;
  syncing = true;
  try {
    const [productsSnapshot, bookingsSnapshot, favoritesSnapshot, commentsSnapshot, imagesSnapshot, buyerMessagesSnapshot, sellerMessagesSnapshot] = await Promise.all([
      getDocs(collection(db, 'products')),
      getDocs(query(collection(db, 'bookings'), where('buyerId', '==', activeUser.uid))),
      getDocs(collection(db, 'favorites', activeUser.uid, 'items')),
      getDocs(collection(db, 'comments')),
      getDocs(collection(db, 'images')),
      getDocs(query(collection(db, 'messages'), where('buyerId', '==', activeUser.uid))),
      getDocs(query(collection(db, 'messages'), where('sellerId', '==', activeUser.uid)))
    ]);

    const products = productsSnapshot.docs.map(snapshot => ({ id: snapshot.id, ...snapshot.data() }));
    const bookings = bookingsSnapshot.docs.map(snapshot => ({ firebaseId: snapshot.id, ...snapshot.data() }));
    const comments = commentsSnapshot.docs.map(snapshot => ({ firebaseId: snapshot.id, ...snapshot.data() }));
    const messages = [...buyerMessagesSnapshot.docs, ...sellerMessagesSnapshot.docs]
      .reduce((unique, snapshot) => unique.has(snapshot.id) ? unique : unique.set(snapshot.id, { firebaseId: snapshot.id, ...snapshot.data() }), new Map());
    const favorites = favoritesSnapshot.docs.map(snapshot => snapshot.id);
    const images = new Map(imagesSnapshot.docs.map(snapshot => [snapshot.id, snapshot.data()]));

    await Promise.all(products.map(async product => {
      const image = images.get(product.id);
      if (!image?.dataUrl) return;
      product.photoId = `firestore-${product.id}`;
      await putLocalPhoto(product.photoId, dataUrlToBlob(image.dataUrl));
    }));

    window.badaApplyData({ products, bookings, comments, messages: [...messages.values()], favorites }, {
      uid: activeUser.uid,
      displayName: displayName(activeUser),
      email: activeUser.email
    });
  } finally {
    syncing = false;
  }
}

function authMessage(error) {
  const messages = {
    'auth/email-already-in-use': '이미 가입된 이메일이에요. 로그인해 주세요.',
    'auth/invalid-email': '이메일 형식을 확인해 주세요.',
    'auth/invalid-credential': '이메일 또는 비밀번호가 올바르지 않아요.',
    'auth/weak-password': '비밀번호는 6자 이상 입력해 주세요.',
    'auth/too-many-requests': '로그인 시도가 너무 많아요. 잠시 후 다시 시도해 주세요.',
    'auth/network-request-failed': '인터넷 연결을 확인해 주세요.',
    'auth/popup-closed-by-user': 'Google 로그인 창이 닫혔어요.'
  };
  return messages[error.code] || error.message || '로그인 처리 중 문제가 생겼어요. 다시 시도해 주세요.';
}

async function finishLogin(role) {
  activeUser = auth.currentUser;
  try {
    await sync();
  } catch (error) {
    console.warn('Initial data sync failed:', error);
  }
  sessionStorage.removeItem('badaPendingRole');
  window.show?.(role);
}

async function loginWithGoogle(role) {
  try {
    sessionStorage.setItem('badaPendingRole', role);
    if (!auth.currentUser) await signInWithPopup(auth, new GoogleAuthProvider());
    await finishLogin(role);
  } catch (error) {
    console.error(error);
    notice(authMessage(error));
  }
}

const normalizeLoginId = value => String(value || '').trim().toLowerCase();

// Firebase 이메일/비밀번호 인증을 사용하되, 이용자에게는 아이디만 받는다.
// 실제 메일 주소를 요구하거나 별도의 Firestore 아이디 매핑을 만들지 않는다.
const emailForId = identifier => {
  const value = String(identifier || '').trim();
  if (value.includes('@')) return value; // 기존 이메일 계정도 계속 로그인 가능
  const loginId = normalizeLoginId(value);
  if (!/^[a-z0-9_]{3,16}$/.test(loginId)) {
    throw new Error('아이디는 영문 소문자, 숫자, _로 3~16자 입력해 주세요.');
  }
  return `${loginId}@bada-market.app`;
};

async function emailForLogin(identifier) {
  return emailForId(identifier);
}

async function loginWithEmail(identifier, password, role) {
  try {
    sessionStorage.setItem('badaPendingRole', role);
    const email = await emailForLogin(identifier);
    await signInWithEmailAndPassword(auth, email, password);
    await finishLogin(role);
  } catch (error) {
    console.error(error);
    notice(authMessage(error));
  }
}

async function registerWithEmail(loginIdInput, password, role) {
  try {
    const loginId = normalizeLoginId(loginIdInput);
    if (!/^[a-z0-9_]{3,16}$/.test(loginId)) throw new Error('아이디는 영문 소문자·숫자·_로 3~16자 입력해 주세요.');
    const email = emailForId(loginId);
    sessionStorage.setItem('badaPendingRole', role);
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(credential.user, { displayName: loginId });
    activeUser = credential.user;
    await setDoc(doc(db, 'users', activeUser.uid), {
      displayName: loginId,
      loginId,
      email,
      createdAt: Date.now()
    }).catch(error => console.warn('Profile document could not be saved:', error));
    await finishLogin(role);
    notice(`${loginId}님, 회원가입이 완료됐어요.`);
  } catch (error) {
    console.error(error);
    notice(authMessage(error));
  }
}

async function resetPassword(identifier) {
  try {
    const email = await emailForLogin(identifier);
    await sendPasswordResetEmail(auth, email);
    notice('비밀번호 재설정 메일을 보냈어요.');
  } catch (error) {
    console.error(error);
    notice(authMessage(error));
  }
}

async function logout() {
  await signOut(auth);
  sessionStorage.removeItem('badaPendingRole');
  localStorage.removeItem('badaMarketDataV3');
  localStorage.removeItem('badaFavorites');
  window.badaSignedOut();
}

async function saveProduct(product, photoFile, isEditing) {
  if (!activeUser) return loginWithGoogle('fisher');
  try {
    const oldProduct = isEditing
      ? (await runTransaction(db, async transaction => {
          const snapshot = await transaction.get(doc(db, 'products', product.id));
          if (!snapshot.exists() || snapshot.data().ownerId !== activeUser.uid) throw new Error('내 상품만 수정할 수 있어요.');
          return snapshot.data();
        }))
      : null;

    const payload = {
      ...oldProduct,
      ...product,
      ownerId: activeUser.uid,
      owner: displayName(activeUser),
      reserved: Number(oldProduct?.reserved || 0),
      saleStopped: Boolean(oldProduct?.saleStopped),
      updatedAt: Date.now()
    };

    if (photoFile) {
      notice('사진을 무료 저장 용량에 맞게 압축하고 있어요.');
      const dataUrl = await compressPhoto(photoFile);
      await setDoc(doc(db, 'images', product.id), {
        ownerId: activeUser.uid,
        dataUrl,
        updatedAt: Date.now()
      });
      payload.photoId = `firestore-${product.id}`;
    }

    await setDoc(doc(db, 'products', product.id), payload);
    await sync();
    notice(isEditing ? '상품 정보를 수정했어요.' : '수산물을 등록했어요.');
  } catch (error) {
    console.error(error);
    notice(error.message || '상품 저장에 실패했어요.');
    throw error;
  }
}

async function updateProduct(id, changes) {
  const productRef = doc(db, 'products', id);
  try {
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(productRef);
      if (!snapshot.exists() || (snapshot.data().ownerId !== activeUser?.uid && activeUser?.uid !== ADMIN_UID)) throw new Error('내 상품 또는 관리자만 변경할 수 있어요.');
      transaction.update(productRef, { ...changes, updatedAt: Date.now() });
    });
    await sync();
    notice(changes.saleStopped === true ? '판매를 중단했어요. 기존 예약은 그대로 보호됩니다.' : '상품 정보를 변경했어요.');
  } catch (error) {
    console.error(error);
    notice(error.message || '상품 변경에 실패했어요.');
  }
}

async function deleteProduct(id) {
  const productRef = doc(db, 'products', id);
  try {
    const initialSnapshot = await runTransaction(db, transaction => transaction.get(productRef));
    if (!initialSnapshot.exists() || (initialSnapshot.data().ownerId !== activeUser?.uid && activeUser?.uid !== ADMIN_UID)) throw new Error('내 상품 또는 관리자만 삭제할 수 있어요.');
    if (Number(initialSnapshot.data().reserved || 0) > 0) throw new Error('예약자가 있는 상품은 삭제할 수 없어요. 판매 중단을 이용해 주세요.');
    const product = initialSnapshot.data();
    if (!confirm(`${product.name} 상품을 삭제할까요?`)) return;
    await runTransaction(db, async transaction => {
      const latestSnapshot = await transaction.get(productRef);
      if (!latestSnapshot.exists() || (latestSnapshot.data().ownerId !== activeUser?.uid && activeUser?.uid !== ADMIN_UID)) throw new Error('내 상품 또는 관리자만 삭제할 수 있어요.');
      if (Number(latestSnapshot.data().reserved || 0) > 0) throw new Error('방금 예약이 접수되어 삭제할 수 없어요. 판매 중단을 이용해 주세요.');
      transaction.delete(productRef);
    });
    await deleteDoc(doc(db, 'images', id)).catch(() => {});
    await sync();
    notice('상품을 삭제했어요.');
  } catch (error) {
    console.error(error);
    notice(error.message || '상품 삭제에 실패했어요.');
  }
}

async function deleteProductAsAdmin(id) {
  try {
    if (activeUser?.uid !== ADMIN_UID) throw new Error('관리자만 상품을 관리할 수 있어요.');
    const productSnapshot = await getDoc(doc(db, 'products', id));
    if (!productSnapshot.exists()) throw new Error('상품을 찾을 수 없어요.');
    const product = productSnapshot.data();
    const hasReservations = Number(product.reserved || 0) > 0;
    const message = hasReservations
      ? '예약이 있는 상품입니다. 구매자 보호를 위해 삭제 대신 판매를 중단할까요?'
      : `${product.name} 상품을 삭제할까요?`;
    if (!confirm(message)) return;
    if (hasReservations) {
      await updateDoc(doc(db, 'products', id), { saleStopped: true, moderatedAt: Date.now() });
      notice('예약이 있어 판매 중단으로 처리했어요.');
    } else {
      await deleteDoc(doc(db, 'products', id));
      await deleteDoc(doc(db, 'images', id)).catch(() => {});
      notice('관리자 권한으로 상품을 삭제했어요.');
    }
    await sync();
  } catch (error) {
    console.error(error);
    notice(error.message || '상품 관리에 실패했어요.');
  }
}

async function reserve(productId, quantity) {
  if (!activeUser) return loginWithGoogle('citizen');
  const productRef = doc(db, 'products', productId);
  const bookingRef = doc(collection(db, 'bookings'));
  try {
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(productRef);
      if (!snapshot.exists()) throw new Error('상품이 존재하지 않아요.');
      const product = snapshot.data();
      if (product.ownerId === activeUser.uid) throw new Error('내가 등록한 상품은 예약할 수 없어요.');
      if (product.saleStopped) throw new Error('판매가 중단된 상품이에요.');
      if (new Date(product.arrival).getTime() < Date.now()) throw new Error('예상 입항 시간이 지난 상품은 예약할 수 없어요.');
      const available = Number(product.quantity) - Number(product.reserved || 0);
      if (!quantity || quantity < 1 || quantity > available) throw new Error('남은 수량 안에서 선택해 주세요.');

      transaction.update(productRef, { reserved: Number(product.reserved || 0) + quantity });
      transaction.set(bookingRef, {
        productId,
        buyerId: activeUser.uid,
        sellerId: product.ownerId,
        nickname: displayName(activeUser),
        name: product.name,
        boat: product.boat,
        qty: quantity,
        unit: product.unit,
        pickup: product.pickup,
        status: product.status,
        productStatus: product.status,
        arrival: product.arrival,
        bookingStatus: 'reserved',
        createdAt: Date.now()
      });
    });
    await sync();
    notice('예약이 완료됐어요.');
  } catch (error) {
    console.error(error);
    notice(error.message || '예약에 실패했어요.');
  }
}

async function cancelBooking(bookingId) {
  const bookingRef = doc(db, 'bookings', bookingId);
  try {
    await runTransaction(db, async transaction => {
      const bookingSnapshot = await transaction.get(bookingRef);
      if (!bookingSnapshot.exists() || bookingSnapshot.data().buyerId !== activeUser?.uid) throw new Error('내 예약만 취소할 수 있어요.');
      const booking = bookingSnapshot.data();
      const productRef = doc(db, 'products', booking.productId);
      const productSnapshot = await transaction.get(productRef);
      if (!productSnapshot.exists()) throw new Error('상품 정보를 찾을 수 없어요.');
      const product = productSnapshot.data();
      const deadline = new Date(product.arrival).getTime() - 60 * 60 * 1000;
      if (Date.now() > deadline) throw new Error('예상 입항시간 1시간 전까지만 예약을 취소할 수 있어요.');
      transaction.update(productRef, {
        reserved: Math.max(0, Number(product.reserved || 0) - Number(booking.qty || 0))
      });
      transaction.update(bookingRef, {
        bookingStatus: 'cancelled',
        cancelledAt: Date.now()
      });
    });
    await sync();
    notice('예약을 취소했어요. 수량이 다시 판매 목록에 반영됐습니다.');
  } catch (error) {
    console.error(error);
    notice(error.message || '예약 취소에 실패했어요.');
  }
}

async function toggleFavorite(productId) {
  if (!activeUser) return loginWithGoogle('citizen');
  const favoriteRef = doc(db, 'favorites', activeUser.uid, 'items', productId);
  const current = JSON.parse(localStorage.getItem('badaFavorites') || '[]');
  if (current.includes(productId)) await deleteDoc(favoriteRef);
  else await setDoc(favoriteRef, { productId, createdAt: Date.now() });
  await sync();
}

async function addComment(productId, text) {
  if (!text || !activeUser) return;
  const productSnapshot = await runTransaction(db, transaction => transaction.get(doc(db, 'products', productId)));
  if (!productSnapshot.exists()) return notice('상품을 찾을 수 없어요.');
  const commentRef = doc(collection(db, 'comments'));
  await setDoc(commentRef, {
    productId,
    sellerId: productSnapshot.data().ownerId,
    authorId: activeUser.uid,
    authorName: displayName(activeUser),
    text,
    createdAt: Date.now()
  });
  await sync();
  notice('댓글을 등록했어요.');
}

async function replyToComment(commentId, text) {
  if (!text || !activeUser) return;
  try {
    const commentRef = doc(db, 'comments', commentId);
    const commentSnapshot = await getDoc(commentRef);
    if (!commentSnapshot.exists()) throw new Error('질문을 찾을 수 없어요.');
    const comment = commentSnapshot.data();
    if (comment.sellerId !== activeUser.uid) throw new Error('이 상품의 판매자만 답장할 수 있어요.');
    await updateDoc(commentRef, {
      replyText: text,
      replyAuthorId: activeUser.uid,
      replyAuthorName: displayName(activeUser),
      repliedAt: Date.now()
    });
    await sync();
    notice('구매자에게 답장을 등록했어요.');
  } catch (error) {
    console.error(error);
    notice(error.message || '답장 등록에 실패했어요.');
  }
}

async function deleteCommentAsAdmin(commentId) {
  try {
    if (activeUser?.uid !== ADMIN_UID) throw new Error('관리자만 댓글을 삭제할 수 있어요.');
    if (!confirm('이 댓글을 삭제할까요?')) return;
    await deleteDoc(doc(db, 'comments', commentId));
    await sync();
    notice('댓글을 삭제했어요.');
  } catch (error) {
    console.error(error);
    notice(error.message || '댓글 삭제에 실패했어요.');
  }
}

async function hideProductAsAdmin(productId) {
  try {
    if (activeUser?.uid !== ADMIN_UID) throw new Error('관리자만 상품을 숨길 수 있어요.');
    if (!confirm('이 상품을 구매 화면에서 숨길까요? 기존 예약은 보존됩니다.')) return;
    await updateDoc(doc(db, 'products', productId), { saleStopped: true, moderatedAt: Date.now() });
    await sync();
    notice('상품을 숨겼어요. 기존 예약은 유지됩니다.');
  } catch (error) {
    console.error(error);
    notice(error.message || '상품 숨김에 실패했어요.');
  }
}

async function sendMessage(bookingId, text) {
  if (!text || !activeUser) return;
  try {
    const bookingSnapshot = await runTransaction(db, transaction => transaction.get(doc(db, 'bookings', bookingId)));
    if (!bookingSnapshot.exists()) throw new Error('예약 정보를 찾을 수 없어요.');
    const booking = bookingSnapshot.data();
    if (booking.buyerId !== activeUser.uid && booking.sellerId !== activeUser.uid) throw new Error('이 예약의 판매자·구매자만 메시지를 보낼 수 있어요.');
    await setDoc(doc(collection(db, 'messages')), {
      bookingId,
      productId: booking.productId,
      buyerId: booking.buyerId,
      sellerId: booking.sellerId,
      senderId: activeUser.uid,
      senderName: displayName(activeUser),
      text,
      createdAt: Date.now()
    });
    await sync();
    notice('판매자에게 메시지를 보냈어요.');
  } catch (error) {
    console.error(error);
    notice(error.message || '메시지를 보내지 못했어요.');
  }
}

window.badaApi = {
  loginWithGoogle,
  loginWithEmail,
  registerWithEmail,
  resetPassword,
  logout,
  saveProduct,
  updateProduct,
  deleteProduct,
  deleteProductAsAdmin,
  reserve,
  cancelBooking,
  toggleFavorite,
  addComment,
  replyToComment,
  deleteCommentAsAdmin,
  hideProductAsAdmin,
  sendMessage
};

onAuthStateChanged(auth, async user => {
  activeUser = user;
  if (!user) {
    window.badaSignedOut();
    return;
  }
  try {
    await sync();
  } catch (error) {
    console.warn('Auth state data sync failed:', error);
  }
  const role = sessionStorage.getItem('badaPendingRole');
  if (role) {
    sessionStorage.removeItem('badaPendingRole');
    window.show?.(role);
  }
});
