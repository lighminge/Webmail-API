const express = require('express');
const nodemailer = require('nodemailer');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;

const app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*'); 
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

// 增加 JSON 負載上限至 10MB，以容納附件資料
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.get('/', (req, res) => res.json({ status: "OK", message: "Webmail API 伺服器運作中！支援極速分頁與附件。" }));

// --- 查詢信箱總數量 ---
app.post('/api/emails/count', async (req, res) => {
    const { user, pass, imapHost } = req.body;
    try {
        const connection = await imaps.connect({ imap: { user, password: pass, host: imapHost || 'imap.gmail.com', port: 993, tls: true, authTimeout: 8000 } });
        const box = await connection.openBox('INBOX');
        const total = box.messages.total;
        connection.end();
        res.json({ success: true, total });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- 寄信 API (支援附件) ---
app.post('/api/send', async (req, res) => {
    const { user, pass, to, subject, text, html, smtpHost, attachments } = req.body;
    try {
        let transporter = nodemailer.createTransport({
            host: smtpHost || 'smtp.gmail.com', port: 465, secure: true,
            auth: { user, pass }
        });

        let mailOptions = {
            from: user, to, subject, text, html: html || text.replace(/\n/g, '<br>')
        };

        if (attachments && Array.isArray(attachments)) {
            mailOptions.attachments = attachments.map(att => ({
                filename: att.filename,
                content: att.content,
                encoding: 'base64',
                contentType: att.contentType
            }));
        }

        let info = await transporter.sendMail(mailOptions);
        res.json({ success: true, messageId: info.messageId });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/delete', async (req, res) => {
    const { user, pass, imapHost, uids } = req.body;
    if (!uids || !uids.length) return res.status(400).json({ success: false });
    try {
        const connection = await imaps.connect({ imap: { user, password: pass, host: imapHost || 'imap.gmail.com', port: 993, tls: true, authTimeout: 8000 } });
        await connection.openBox('INBOX');
        await connection.addFlags(uids, '\\Deleted');
        await connection.imap.expunge((err) => { if (err) throw err; });
        connection.end();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/mark-read', async (req, res) => {
    const { user, pass, imapHost, uid } = req.body;
    try {
        const connection = await imaps.connect({ imap: { user, password: pass, host: imapHost || 'imap.gmail.com', port: 993, tls: true, authTimeout: 8000 } });
        await connection.openBox('INBOX');
        await connection.addFlags(uid, '\\Seen');
        connection.end();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/mark-answered', async (req, res) => {
    const { user, pass, imapHost, uid } = req.body;
    try {
        const connection = await imaps.connect({ imap: { user, password: pass, host: imapHost || 'imap.gmail.com', port: 993, tls: true, authTimeout: 8000 } });
        await connection.openBox('INBOX');
        await connection.addFlags(uid, '\\Answered');
        connection.end();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- 收信 API (終極相容版：改用 IMAP 原生 FETCH 取得 UID，解決 Gmail 當機與 Yahoo 缺信問題) ---
app.post('/api/emails', async (req, res) => {
    const { user, pass, imapHost, page = 1, limit = 30 } = req.body;
    try {
        // 延長連線超時，確保網路波動時不會被 Vercel 切斷
        const connection = await imaps.connect({ imap: { user, password: pass, host: imapHost || 'imap.gmail.com', port: 993, tls: true, authTimeout: 15000 } });
        const box = await connection.openBox('INBOX');
        const totalMessages = box.messages.total;

        if (totalMessages === 0) {
            connection.end();
            return res.json({ success: true, emails: [], total: 0 });
        }

        // 精準計算要抓取的序列範圍 (Sequence Range)
        const end = totalMessages - (page - 1) * limit;
        const start = Math.max(1, end - limit + 1);

        if (end < 1) {
            connection.end();
            return res.json({ success: true, emails: [], total: totalMessages });
        }

        // 【終極解法】利用 IMAP 底層 FETCH 指令，直接命令伺服器交出這區間的所有 UID
        // 這個做法完全繞過 SEARCH，保證 Gmail 不會報錯，Yahoo 也會乖乖交出 30 筆資料
        const targetUids = await new Promise((resolve, reject) => {
            const foundUids = [];
            const f = connection.imap.seq.fetch(`${start}:${end}`);
            f.on('message', (msg) => {
                msg.once('attributes', (attrs) => {
                    if (attrs && attrs.uid) {
                        foundUids.push(attrs.uid);
                    }
                });
            });
            f.once('error', (err) => reject(err));
            f.once('end', () => resolve(foundUids));
        });

        if (targetUids.length === 0) {
            connection.end();
            return res.json({ success: true, emails: [], total: totalMessages });
        }

        // 拿到精準的 UID 後，才進行信件內文的完整下載
        const searchCriteria = [['UID', targetUids.join(',')]];
        const messages = await connection.search(searchCriteria, { bodies: ['HEADER', 'TEXT', ''], markSeen: false });
        let parsedEmails = [];

        for (let item of messages) {
            const all = item.parts.find(part => part.which === '');
            if (!all) continue;
            
            const id = item.attributes.uid;
            const parsed = await simpleParser("Imap-Id: "+id+"\r\n" + all.body);
            const senderEmail = parsed.from && parsed.from.value.length > 0 ? parsed.from.value[0].address : '未知寄件者';

            let attachments = [];
            if (parsed.attachments && parsed.attachments.length > 0) {
                for (let att of parsed.attachments) {
                    if (att.size > 3 * 1024 * 1024) {
                        attachments.push({ filename: att.filename, contentType: att.contentType, size: att.size, error: true });
                    } else if (att.content) {
                        attachments.push({
                            filename: att.filename,
                            contentType: att.contentType,
                            size: att.size,
                            content: att.content.toString('base64')
                        });
                    }
                }
            }

            parsedEmails.push({
                id: id,
                subject: parsed.subject || '(無主旨)',
                sender: senderEmail,
                senderName: parsed.from && parsed.from.value.length > 0 ? parsed.from.value[0].name : senderEmail,
                body: parsed.text || '',
                html: parsed.html || parsed.textAsHtml || '', 
                bodySnippet: parsed.text ? parsed.text.substring(0, 50).replace(/\n/g, ' ') : '',
                timestamp: parsed.date ? parsed.date.getTime() : Date.now(),
                read: item.attributes.flags.includes('\\Seen'),
                replied: item.attributes.flags.includes('\\Answered'),
                attachments: attachments
            });
        }
        connection.end();
        
        // 將結果重新排列，讓最新信件在最上面
        parsedEmails.sort((a, b) => b.timestamp - a.timestamp);
        res.json({ success: true, emails: parsedEmails, total: totalMessages });

    } catch (error) { 
        console.error("Fetch Error:", error);
        res.status(500).json({ success: false, error: error.message }); 
    }
});

module.exports = app;
