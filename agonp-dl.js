'use strict';
const cheerio =  require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const qstring = require('querystring');
const urllib = require('url');

const siteUrl = {
    MYPAGE: 'https://agonp.jp/mypage',
    LOGIN: 'https://agonp.jp/auth/login',
    EPISODE_VIEW: 'https://agonp.jp/episodes/view/${episodeId}',
    APAPI_MEDIA_URL: 'https://agonp.jp/api/v1/episodes/media_url.json',
    APAPI_MEDIA_VIEW: 'https://agonp.jp/api/v1/programs/episodes/view.json'
};

const TEST_PROGRAM_ID = 21;
const TEST_EPISODE_ID = 22;

function parseJson(s) {
    try {
        return JSON.parse(s);
    } catch (e) {
        throw new Error('invalid JSON');
    }
}

class AgonP {
    constructor() {
        var request = require('request');
        this.requestJar = request.jar();
        this.request = request.defaults({
            jar: this.requestJar,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/56.0.2924.87 Safari/537.36'
            }
        });
    }
    requestAsync(params, reqCallback) {
        var self = this;
        if ('[object String]' == {}.toString.call(params)) {
            params = { url: params };
        }
        return new Promise((resolve, reject) => {
            // console.log(params);
            var req = self.request(params, (err, res) => {
                if (null != err) {
                    reject(err);
                } else if (200 != res.statusCode) {
                    err = new Error('status: ' + res.statusCode + ' ' + res.statusMessage);
                    err.response = res;
                    reject(err);
                } else {
                    resolve(res);
                }
            });
            if ('function' == typeof reqCallback) {
                reqCallback(req);
            }
        });
    }
    findCookie(url, key) {
        for (let cookie of this.requestJar.getCookies(url)) {
            if (key == cookie.key) {
                return cookie.value;
            }
        }
        return null;
    }
    login(email, password) {
        let formData = {
            email: email,
            password: password,
            submit: 'ログイン'
        };
        return this.requestAsync({
            url: siteUrl.LOGIN,
            method: 'POST',
            form: formData,
            followAllRedirects: true
        })
            .then((res) => {
                if (-1 < res.request.href.indexOf(siteUrl.LOGIN)) {
                    let err = new Error('loginFailed');
                    return Promise.reject(err);
                }
            });
    }
    loginIfNotLogined(email, password) {
        return this.requestAsync(siteUrl.MYPAGE)
            .then((res) => {
                if (-1 == res.request.href.indexOf(siteUrl.MYPAGE)) {
                    return this.login(email, password);
                }
            });
    }
    getEpisodeInfo(episodeId) {
        return this.requestAsync(siteUrl.EPISODE_VIEW.replace('${episodeId}', episodeId))
            .then((res) => {
                var body = res.body.toString();
                var $ = cheerio.load(body);
                var title = $('title').text()
                    .replace(/<br\s*>/g, '\x20')
                    .replace(/^\s+|\s+$/g, '')
                    .replace(/\s+/g, '\x20');
                if ('エラー' == title) {
                    let msg = $('.panel-body').children('p').text();
                    return Promise.reject(new Error(msg));
                }
                var m;
                if(!(m = body.match(/\s+program_id\s+:\s+([1-9]+\d*)/)))
                    return Promise.reject(new Error('regexNotMatch'));
                var programId = m[1];
                if(!(m = body.match(/\s+media_mode\s+:\s+"(.*?)"/)))
                    return Promise.reject(new Error('regexNotMatch'));
                var mediaFormat = m[1];
                return {
                    title: title,
                    programId: programId,
                    episodeId: episodeId,
                    mediaFormat: mediaFormat
                };
            });
    }
    getMediaUrl(episodeId, mediaFormat = 'mp4', size = 'small') {
        if (!/^[1-9]+\d*$/.test(episodeId)) {
            let err = new TypeError('episodeId must be positive number, given: ' + episodeId);
            return Promise.reject(err);
        }
        if (!/^mp3$/.test(mediaFormat)) {
            mediaFormat = 'mp4';
        }
        return this.requestAsync({
            url: siteUrl.APAPI_MEDIA_URL + '?' + qstring.stringify({
                episode_id: episodeId,
                format: mediaFormat,
                size: size
            })
        })
            .then((res) => {
                var result = parseJson(res.body);
                if (true !== result.data.success) {
                    let err = new Error('apiError, message: ' + result.data.error);
                    return Promise.reject(err);
                }
                return result.data.url;
            });
    }
    getCsrfToken(forceUpdate = false) {
        var token = this.findCookie(siteUrl.APAPI_MEDIA_VIEW, 'fuel_csrf_token');
        if (true != forceUpdate && token) {
            return Promise.resolve(token);
        }
        return this.requestAsync({
            url: siteUrl.APAPI_MEDIA_VIEW,
            method: 'POST',
            form: {
                format: 'mp4',
                program_id: TEST_PROGRAM_ID,
                episode_id: TEST_EPISODE_ID,
                time: -1,
                fuel_csrf_token: ''
            }
        })
            .then((res) => {
                var token = this.findCookie(siteUrl.APAPI_MEDIA_VIEW, 'fuel_csrf_token');
                if (null == token) {
                    let err = new Error('tokenRequestFailed');
                    return Promise.reject(err);
                }
                return token;
            });
    }
    getMediaState(token, programId, episodeId, mediaFormat = 'mp4') {
        if (!/^[1-9]+\d*$/.test(programId)) {
            let err = new TypeError('programId must be positive number, given: ' + programId);
            return Promise.reject(err);
        }
        if (!/^[1-9]+\d*$/.test(episodeId)) {
            let err = new TypeError('episodeId must be positive number, given: ' + episodeId);
            return Promise.reject(err);
        }
        if (!/^mp3$/.test(mediaFormat)) {
            mediaFormat = 'mp4';
        }
        return (null == token ? this.getCsrfToken() : Promise.resolve(token))
            .then((token) => {
                return this.requestAsync({
                    url: siteUrl.APAPI_MEDIA_VIEW,
                    method: 'POST',
                    form: {
                        format: mediaFormat,
                        program_id: programId,
                        episode_id: episodeId,
                        time: -1,
                        fuel_csrf_token: token
                    }
                });
            })
            .then((res) => {
                var result = parseJson(res.body);
                // console.log(JSON.stringify(result, '', '  '));
                if (true !== result.data.success) {
                    let err = new Error('apiError, message: ' + result.data.error);
                    return Promise.reject(err);
                }
                return result.data.result.state;
            })
    }
    prepareMediaRequest(programId, episodeId) {
        if (0 == arguments.length) {
            programId = TEST_PROGRAM_ID;
            episodeId = TEST_EPISODE_ID;
        } else {
            if (!/^[1-9]+\d*$/.test(programId)) {
                let err = new TypeError('programId must be positive number, given: ' + programId);
                return Promise.reject(err);
            }
            if (!/^[1-9]+\d*$/.test(episodeId)) {
                let err = new TypeError('episodeId must be positive number, given: ' + episodeId);
                return Promise.reject(err);
            }
        }
        return this.getMediaState(null, programId, episodeId);
    }
}

function main() {
    var myAccount = fs.readJsonSync('./account.json');
    var episodeId = process.argv[2];
    if (!/^[1-9]+\d*$/.test(episodeId)) {
        console.log('Usage: node ' + path.basename(__filename) + ' <episode_id>');
        return;
    }
    var programId, title, mediaFormat, mediaUrl;
    var agonp = new AgonP();
    var outputDir = path.join(process.cwd(), './rec.agonp');
    console.log('ログイン処理');
    agonp.loginIfNotLogined(myAccount.email, myAccount.password)
        .then(() => {
            console.log('メディアの情報を取得');
            return agonp.getEpisodeInfo(episodeId);
        })
        .then((info) => {
            // console.log(info);
            ({ programId, title, mediaFormat } = info);
            console.log('メディアのURLを取得');
            return agonp.getMediaUrl(episodeId);
        })
        .then((result) => {
            mediaUrl = result;
            console.log('ダウンロード前処理');
            fs.mkdirpSync(outputDir);
            return agonp.prepareMediaRequest(programId, episodeId);
        })
        .then(() => {
            console.log('ダウンロード開始');
            return agonp.requestAsync({
                url: mediaUrl,
                headers: { Referer: 'https://agonp.jp/episodes/view/' + episodeId }
            }, (req) => {
                var outputFile = path.join(outputDir, title + '.ep' + episodeId + '.' + mediaFormat);
                var wStream = fs.createWriteStream(outputFile);
                var progressChars = ['＼', '│', '／', '─', '＼'];
                var progressCnt = 0;
                wStream.on('drain', () => { 
                    process.stdout.write('' + progressChars[++progressCnt % progressChars.length] + '\r');
                });
                wStream.on('close', () => {
                    process.stdout.write('\n終了');
                });
                wStream.on('error', (err) => console.log(err));
                req.pipe(wStream);
            });
        })
        .catch((err) => {
            console.log(err);
        });
}

if (require.main === module) {
    main();
} else {
    module.exports = AgonP;
}