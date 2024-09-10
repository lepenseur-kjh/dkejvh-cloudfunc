/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

// FCM 메시지 예약 함수
exports.scheduleNotification = functions.firestore
    .document('Users/{userId}/Schedules/{docId}')
    .onCreate(async (change, context) => {
        const newValue = change.data();  // 생성되는 데이터
        const userId = context.params.userId;
        const docId = context.params.docId;

        // userId의 fcmToken 필드에 접근
        const userDoc = await admin.firestore().collection('Users').doc(userId).get();
        const userFcmToken = userDoc.data().fcmToken;


        // deadline을 Date 객체로 변환
        const deadline = newValue.deadline.toDate();

        // 데이터 생성 다음날부터 지정 시간에 푸시 알림 설정
        // 서버 시간 기준으로 현재 시간을 가져옴
        const serverDate = new Date();  // UTC

        // 한국 시간으로 변환
        const koreaOffset = 9 * 60;  // 한국은 UTC+9
        const koreaDate = new Date(serverDate.getTime() + (koreaOffset * 60000));

        const tomorrow = new Date(koreaDate);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(newValue.notificationTime, 0, 0, 0);
        
        const scheduledNotifications = [];

        // tomorrow부터 deadline까지 매일 반복
        for (let currentDate = new Date(tomorrow); currentDate <= deadline; currentDate.setDate(currentDate.getDate() + 1)) {
            const message = {
                data: {
                    title: "일정 관리 안내",
                    body: `'${newValue.content}' 일정을 잊지 마세요!`,
                    scheduledDate: currentDate.toISOString(),
                },
                token: userFcmToken,  // 사용자의 FCM 토큰
            };

            scheduledNotifications.push({
                userId: userId,
                docId: docId,
                message: message,
                scheduledTime: new Date(currentDate - (koreaOffset * 60000)),
            });
        }

        // 배치 작업으로 모든 예약 알림 추가
        const batch = admin.firestore().batch();
        const scheduledNotificationsRef = admin.firestore().collection('scheduledNotifications');

        scheduledNotifications.forEach((notification) => {
            const newNotificationRef = scheduledNotificationsRef.doc();
            batch.set(newNotificationRef, notification);
        });

        // 배치 커밋
        return batch.commit();
    });

// 예약된 알림 전송 함수 (Pub/Sub 트리거 사용)
// 정각에 푸시 알림 발송
exports.sendScheduledNotifications = functions.pubsub
    .schedule('every 1 hours')
    .onRun(async (context) => {
        // 현재 시각의 정각 계산
        // 서버 시간 기준으로 현재 시간을 가져옴
        const serverDate = new Date();  // UTC

        // 한국 시간으로 변환
        const koreaOffset = 9 * 60;  // 한국은 UTC+9
        const koreaDate = new Date(serverDate.getTime() + (koreaOffset * 60000));

        const now = new Date(koreaDate);
        now.setMinutes(0, 0, 0);
        
        // Firestore Timestamp로 변환
        const currentHourTimestamp = admin.firestore.Timestamp.fromDate(now);
        console.log(`배치 실행 시간: ${currentHourTimestamp}`);

        const query = admin.firestore()
            .collection('scheduledNotifications')
            .where('scheduledTime', '==', currentHourTimestamp);

        const snapshot = await query.get();
        
        // 시도 실패 시,
        // 첫 번째는 재시도
        // 두 번째부터는 삭제
        const sendPromises = snapshot.docs.map(async (doc) => {
            const { message, retryCount = 0 } = doc.data();
            
            try {
                await admin.messaging().send(message);
                return doc.ref.delete();
            } catch (error) {
                console.error('배치 실행 에러:', error);
                
                if (retryCount < 1) {
                    // 첫 번째 실패: 재시도 횟수 증가
                    return doc.ref.update({ retryCount: retryCount + 1, lastError: error.message });
                } else {
                    // 두 번째 실패: 문서 삭제
                    return doc.ref.delete();
                }
            }
        });

        await Promise.all(sendPromises);

        console.log(`배치 완료 시간: ${now.toISOString()}`);
        return null;
    });


// 스케줄이 삭제될 때, 남아있는 배치 삭제
exports.deleteScheduleNotifications = functions.firestore
    .document('Users/{userId}/Schedules/{docId}')
    .onDelete(async (change, context) => {
        const { userId, docId } = context.params;

        const batch = admin.firestore().batch();
        const notificationsRef = admin.firestore().collection('scheduledNotifications');
        
        const query = notificationsRef
            .where('userId', '==', userId)
            .where('docId', '==', docId);

        const snapshot = await query.get();

        snapshot.forEach((doc) => {
            batch.delete(doc.ref);
        });

        await batch.commit();

        console.log(`일정 삭제 ${snapshot.size} notifications for Schedules ${docId} of User ${userId}`);
        return null;
    });