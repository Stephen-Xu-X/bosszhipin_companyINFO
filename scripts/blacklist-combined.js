// ==UserScript==
// @name         BOSS直聘脚本
// @namespace    https://github.com/Stephen-Xu-X/bosszhipin_companyINFO
// @version      2.0.1
// @description  公司信息查询与岗位信息辅助显示
// @author       Stephen-Xu-X
// @license      GPLv3

// @match        https://*.zhipin.com/*
// @match        https://*.51job.com/*

// @connect      kjxb.org

// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue

// @require      https://unpkg.com/jquery

// @updateURL    https://raw.githubusercontent.com/Stephen-Xu-X/bosszhipin_companyINFO/main/scripts/blacklist-combined.js
// @downloadURL  https://raw.githubusercontent.com/Stephen-Xu-X/bosszhipin_companyINFO/main/scripts/blacklist-combined.js

// ==/UserScript==

(function () {
	'use strict';

	// ==================== 平台检测 ====================
	var isBOSS = location.host.indexOf('zhipin.com') !== -1;
	var is51job = location.host.indexOf('51job.com') !== -1;

	// ==================== 通用配置 ====================
	var blacklistCache = {};
	var pendingQueries = {};
	var processedNodes = {};

	// ==================== 通用工具函数 ====================
	function cleanText(text) {
		var company_replace = ['\n', '\r', '...', '公司名称', '企业名称：'];
		var company_name = text;
		for (var i = 0; i < company_replace.length; i++) {
			company_name = company_name.replace(company_replace[i], '');
		}
		return company_name.trim();
	}

	// Toast 提示函数
	function showToast(message, duration) {
		duration = duration || 2000;
		var toast = document.createElement('div');
		toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#323232;color:#fff;padding:12px 24px;border-radius:4px;font-size:14px;z-index:10000;box-shadow:0 2px 5px rgba(0,0,0,0.2);animation:kxb-fadeInOut ' + (duration / 1000) + 's ease-in-out;';
		toast.textContent = message;
		document.body.appendChild(toast);

		var style = document.createElement('style');
		style.id = 'kxb-toast-style';
		if (!document.getElementById('kxb-toast-style')) {
			style.textContent = '@keyframes kxb-fadeInOut { 0% { opacity:0; transform:translateY(10px); } 10% { opacity:1; transform:translateY(0); } 90% { opacity:1; } 100% { opacity:0; transform:translateY(10px); } }';
			document.head.appendChild(style);
		}

		setTimeout(function () {
			if (toast.parentNode) {
				document.body.removeChild(toast);
			}
		}, duration);
	}

	// ==================== 黑名单查询（通用） ====================
	function queryBlacklist(companyName) {
		return new Promise(function (resolve, reject) {
			if (blacklistCache[companyName]) {
				resolve(blacklistCache[companyName]);
				return;
			}

			if (pendingQueries[companyName]) {
				pendingQueries[companyName].push({ resolve: resolve, reject: reject });
				return;
			}

			pendingQueries[companyName] = [];

			var blacklist_search = 'https://kjxb.org/?s=' + encodeURIComponent(companyName) + '&post_type=question';

			GM_xmlhttpRequest({
				method: 'GET',
				url: blacklist_search,
				timeout: 5000,
				onload: function (response) {
					try {
						var html = response.responseText;
						var parser = new DOMParser();
						var doc = parser.parseFromString(html, 'text/html');
						var hyperlink = doc.querySelector('.ap-questions-hyperlink');
						var href = hyperlink ? hyperlink.getAttribute('href') : undefined;

						var result = href ?
							{ found: true, href: href, searchUrl: blacklist_search, doc: doc } :
							{ found: false, searchUrl: blacklist_search };

						blacklistCache[companyName] = result;

						resolve(result);
						if (pendingQueries[companyName]) {
							pendingQueries[companyName].forEach(function (item) {
								item.resolve(result);
							});
							delete pendingQueries[companyName];
						}
					} catch (e) {
						reject(e);
						if (pendingQueries[companyName]) {
							pendingQueries[companyName].forEach(function (item) {
								item.reject(e);
							});
							delete pendingQueries[companyName];
						}
					}
				},
				onerror: function (error) {
					reject(error);
					if (pendingQueries[companyName]) {
						pendingQueries[companyName].forEach(function (item) {
							item.reject(error);
						});
						delete pendingQueries[companyName];
					}
				},
				ontimeout: function () {
					var timeoutError = new Error('Query timeout');
					reject(timeoutError);
					if (pendingQueries[companyName]) {
						pendingQueries[companyName].forEach(function (item) {
							item.reject(timeoutError);
						});
						delete pendingQueries[companyName];
					}
				}
			});
		});
	}

	// ==================== BOSS 直聘功能 ====================
	if (isBOSS) {
		var bossRoutes = [
			{
				name: 'BOSS 搜索页',
				paths: ['/web/geek'],
				mode: 'after',
				selectors: ['.boss-name']
			},
			{
				name: 'BOSS 职位详情页',
				paths: ['/job_detail'],
				mode: 'append',
				selectors: ['.level-list > .company-name', 'a[ka="job-detail-company_custompage"]', '.job-detail-company-name', '.company-info .name', '.info-primary .name']
			},
			{
				name: 'BOSS 用户页',
				paths: ['/web/geek'],
				mode: 'append',
				selectors: ['.base-info.fl > span:nth-child(2)', '.name-box > span:nth-child(2)', '.name-box .name', '.base-info .name', '.base-info .company-name']
			},
			{
				name: 'BOSS 公司页',
				paths: ['/gongsi'],
				mode: 'append',
				selectors: ['.info-primary > .info > .name', '.business-detail-name', '.company-info .name', '.company-name']
			}
		];

		var bossScanTimer = null;
		var bossObserver = null;
		var bossEnabled = true;
		var bossScanGeneration = 0;

		function bossEnsureControl() {
			var existing = document.getElementById('kxb-boss-control');
			if (existing) return existing;

			var target = document.querySelector('#header .user-nav, header .user-nav, .header .user-nav, .user-nav');
			if (!target) return null;

			var style = document.getElementById('kxb-boss-control-style');
			if (!style) {
				style = document.createElement('style');
				style.id = 'kxb-boss-control-style';
				style.textContent = '' +
					'#kxb-boss-control{display:inline-flex;align-items:center;gap:10px;margin-left:12px;vertical-align:middle;font-family:Arial,sans-serif;}' +
					'#kxb-boss-toggle{all:unset;display:inline-flex;align-items:center;gap:6px;height:28px;color:#f4f7ff;cursor:pointer;user-select:none;}' +
					'#kxb-boss-toggle:focus-visible,#kxb-boss-github:focus-visible{outline:2px solid #00bebd;outline-offset:3px;border-radius:5px;}' +
					'.kxb-boss-power{font-size:14px;font-weight:700;line-height:18px;}' +
					'.kxb-boss-state{display:block;height:18px;overflow:hidden;color:#42e3d1;font-size:14px;font-weight:700;line-height:18px;}' +
					'.kxb-boss-state span{display:block;transition:transform .28s cubic-bezier(.2,.8,.2,1);}' +
					'#kxb-boss-toggle.is-off .kxb-boss-state{color:#c3cbe0;}' +
					'#kxb-boss-toggle.is-off .kxb-boss-state span{transform:translateY(-18px);}' +
					'.kxb-boss-switch{position:relative;display:block;width:34px;height:18px;border-radius:999px;background:#00bebd;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08);transition:background .28s ease;}' +
					'.kxb-boss-switch::after{content:"";position:absolute;top:3px;left:19px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.22);transition:transform .28s cubic-bezier(.2,.8,.2,1);}' +
					'#kxb-boss-toggle.is-off .kxb-boss-switch{background:#a7afb9;}' +
					'#kxb-boss-toggle.is-off .kxb-boss-switch::after{transform:translateX(-16px);}' +
					'#kxb-boss-github{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:5px;transition:background .2s ease,transform .2s ease;}' +
					'#kxb-boss-github:hover{background:rgba(255,255,255,.12);transform:translateY(-1px);}';
				document.head.appendChild(style);
			}

			var control = document.createElement('div');
			control.id = 'kxb-boss-control';
			control.innerHTML = '<button id="kxb-boss-toggle" type="button" aria-pressed="true" aria-label="关闭公司信息查询"><span class="kxb-boss-power">Power</span><span class="kxb-boss-state"><span>On</span><span>Off</span></span><span class="kxb-boss-switch" aria-hidden="true"></span></button><a id="kxb-boss-github" href="https://github.com/Stephen-Xu-X/bosszhipin_companyINFO" target="_blank" rel="noopener noreferrer" aria-label="打开 GitHub 仓库" title="GitHub 仓库"><svg aria-hidden="true" viewBox="0 0 1024 1024" width="20" height="20" xmlns="http://www.w3.org/2000/svg"><path d="M511.6 76.3C264.3 76.2 64 276.4 64 523.5 64 718.9 189.3 885 363.8 946c23.5 5.9 19.9-10.8 19.9-22.2v-77.5c-135.7 15.9-141.2-73.9-150.3-88.9C215 726 171.5 718 184.5 703c30.9-15.9 62.4 4 98.9 57.9 26.4 39.1 77.9 32.5 104 26 5.7-23.5 17.9-44.5 34.7-60.8-140.6-25.2-199.2-111-199.2-213 0-49.5 16.3-95 48.3-131.7-20.4-60.5 1.9-112.3 4.9-120 58.1-5.2 118.5 41.6 123.2 45.3 33-8.9 70.7-13.6 112.9-13.6 42.4 0 80.2 4.9 113.5 13.9 11.3-8.6 67.3-48.8 121.3-43.9 2.9 7.7 24.7 58.3 5.5 118 32.4 36.8 48.9 82.7 48.9 132.3 0 102.2-59 188.1-200 212.9 23.5 23.2 38.1 55.4 38.1 91v112.5c0.8 9 0 17.9 15 17.9 177.1-59.7 304.6-227 304.6-424.1 0-247.2-200.4-447.3-447.5-447.3z" fill="#00bebd"></path></svg></a>';
			target.appendChild(control);

			var toggle = control.querySelector('#kxb-boss-toggle');
			toggle.addEventListener('click', function () {
				bossEnabled = !bossEnabled;
				bossScanGeneration += 1;
				toggle.classList.toggle('is-off', !bossEnabled);
				toggle.setAttribute('aria-pressed', String(bossEnabled));
				toggle.setAttribute('aria-label', bossEnabled ? '关闭公司信息查询' : '开启公司信息查询');
				if (bossEnabled) {
					bossScheduleScan(true);
				} else {
					bossClearIndicators();
				}
			});
			return control;
		}

		function bossClearIndicators() {
			Array.prototype.forEach.call(document.querySelectorAll('.kxb-beibei, .kxb-boss-tag'), function (node) {
				node.remove();
			});
			Array.prototype.forEach.call(document.querySelectorAll('[data-boss-processed]'), function (node) {
				delete node.dataset.bossProcessed;
				delete node.dataset.bossBadgeGeneration;
			});
		}

		function bossRouteActive(route) {
			return route.paths.some(function (path) {
				return location.pathname.indexOf(path) !== -1;
			});
		}

		function insertNode(node, mode, html) {
			var $node = $(node);
			var $html = $(html);
			if (mode === 'append') $node.append($html);
			else if (mode === 'prepend') $node.prepend($html);
			else if (mode === 'before') $node.before($html);
			else $node.after($html);
		}

		function handleBossNode(node, route, selector) {
			if (!bossEnabled) return;
			var node_class = node.getAttribute('class') || '';
			if (node_class.indexOf('kxb-beibei') !== -1 || node_class.indexOf('base-title') !== -1) return;
			if (node.dataset && node.dataset.bossProcessed === '1') return;
			if (node.dataset) node.dataset.bossProcessed = '1';

			var company_name = cleanText(node.textContent || node.innerText || '');
			if (!company_name) return;
			var scanGeneration = bossScanGeneration;

			queryBlacklist(company_name).then(function (result) {
				if (!bossEnabled || scanGeneration !== bossScanGeneration) return;
				if (node.dataset && node.dataset.bossBadgeGeneration === String(scanGeneration)) return;
				if (node.dataset) node.dataset.bossBadgeGeneration = String(scanGeneration);
				var insert_html = result.found ?
					'<a class="kxb-beibei" target="_blank" style="color:#F00" href="' + result.href + '">&nbsp;🚨&nbsp;</a>' :
					'<a class="kxb-beibei" target="_blank" style="color:#00F" href="' + result.searchUrl + '">&nbsp; 🔍 &nbsp;</a>';
				insertNode(node, route.mode, insert_html);

				// 在 BOSS 搜索页面添加 kjxb 的属性标签
				if (selector === '.boss-name' && result.doc) {
					var card = $(node).closest('li, .job-card-wrapper, .job-card-item, .job-card, .job-list-item, .job-card-left, .job-info');
					var tag_list = card.find('.job-info > .tag-list, .tag-list').first();
					if (tag_list.length > 0) {
						var question_tags_list = result.doc.querySelectorAll('.question-tags > a');
						if (question_tags_list.length > 0) {
							// 把所有标签合并为1个li插入，避免BOSS的CSS只显示第一个标签
							var combined_tags = [];
							for (var i = 0; i < question_tags_list.length; i++) {
								combined_tags.push(question_tags_list[i].innerText);
							}
							var tags_text = combined_tags.join('<span style="color:blue">│</span>');
							var tags_html = $('<li class="kxb-boss-tag"><span style="color:red">' + tags_text + '</span></li>');
							tag_list.prepend(tags_html);
						}
					}
				}
			}).catch(function (error) {
				console.error('BOSS 黑名单查询错误:', error);
			});
		}

		function bossScanAll() {
			bossEnsureControl();
			if (!bossEnabled) return;
			bossRoutes.forEach(function (route) {
				if (!bossRouteActive(route)) return;
				route.selectors.forEach(function (selector) {
					var nodes = document.querySelectorAll(selector);
					Array.prototype.forEach.call(nodes, function (node) {
						handleBossNode(node, route, selector);
					});
				});
			});
		}

		function bossScheduleScan(force) {
			if (bossScanTimer && !force) return;
			if (bossScanTimer) clearTimeout(bossScanTimer);
			bossScanTimer = setTimeout(function () {
				bossScanTimer = null;
				bossScanAll();
			}, force ? 0 : 250);
		}

		function startBossObserver() {
			if (bossObserver) {
				bossObserver.disconnect();
			}
			bossObserver = new MutationObserver(function () {
				bossScheduleScan();
			});
			bossObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });
		}

		function bossStart() {
			if (document.body) {
				bossEnsureControl();
				bossScanAll();
				startBossObserver();
				return;
			}
			document.addEventListener('DOMContentLoaded', function () {
				bossEnsureControl();
				bossScanAll();
				startBossObserver();
			});
		}

		function hookHistory() {
			var pushState = history.pushState;
			var replaceState = history.replaceState;
			history.pushState = function () {
				var result = pushState.apply(this, arguments);
				bossScheduleScan(true);
				return result;
			};
			history.replaceState = function () {
				var result = replaceState.apply(this, arguments);
				bossScheduleScan(true);
				return result;
			};
			window.addEventListener('popstate', function () {
				bossScheduleScan(true);
			});
			window.addEventListener('hashchange', function () {
				bossScheduleScan(true);
			});
		}

		hookHistory();
		bossStart();
	}

	// ==================== 前程无忧功能 ====================
	if (is51job) {
		var processedJobs = {};
		var controlPanel = null;

		// iOS 马卡龙色盘
		var degreeMap = {
			'初中及以下': '#FF3B30',
			'高中': '#FF9500',
			'中技': '#FFCC00',
			'中专': '#FFCC00',
			'大专': '#34C759',
			'本科': '#0A84FF',
			'硕士': '#AF52DE',
			'博士': '#AF52DE',
			'无学历要求': '#999999'
		};

		var experienceMap = {
			'应届毕业生': '#34C759',
			'1年以下': '#34C759',
			'1-3年': '#00B4D8',
			'3-5年': '#0A84FF',
			'5-10年': '#AF52DE',
			'10年以上': '#FF3B30'
		};

		// 隐藏信息提取
		function extractJobInfo(element) {
			try {
				var sensorsdata = element.getAttribute('sensorsdata');
				if (!sensorsdata) return null;

				var data = JSON.parse(sensorsdata);
				return {
					jobId: data.jobId,
					jobTime: data.jobTime,
					jobYear: data.jobYear,
					jobDegree: data.jobDegree
				};
			} catch (e) {
				return null;
			}
		}

		function extract51jobCompanyName(element) {
			try {
				var cnameElement = element.querySelector('.cname');
				if (!cnameElement) return null;
				var companyName = cnameElement.textContent.trim();
				if (!companyName) return null;
				return companyName;
			} catch (e) {
				return null;
			}
		}

		// 颜色映射
		function getExperienceColor(experience) {
			if (!experience) return '#999999';
			if (experienceMap[experience]) return experienceMap[experience];
			if (experience.indexOf('应届') !== -1) return experienceMap['应届毕业生'];
			if (experience.indexOf('1年以下') !== -1) return experienceMap['1年以下'];
			if (experience.indexOf('1-3年') !== -1) return experienceMap['1-3年'];
			if (experience.indexOf('3-5年') !== -1) return experienceMap['3-5年'];
			if (experience.indexOf('5-10年') !== -1) return experienceMap['5-10年'];
			if (experience.indexOf('10年以上') !== -1) return experienceMap['10年以上'];
			return '#999999';
		}

		function getDegreeColor(degree) {
			if (!degree) return degreeMap['无学历要求'];
			if (degreeMap[degree]) return degreeMap[degree];
			if (degree.indexOf('初中') !== -1) return degreeMap['初中及以下'];
			if (degree.indexOf('高中') !== -1) return degreeMap['高中'];
			if (degree.indexOf('中技') !== -1) return degreeMap['中技'];
			if (degree.indexOf('中专') !== -1) return degreeMap['中专'];
			if (degree.indexOf('大专') !== -1) return degreeMap['大专'];
			if (degree.indexOf('本科') !== -1) return degreeMap['本科'];
			if (degree.indexOf('硕士') !== -1) return degreeMap['硕士'];
			if (degree.indexOf('博士') !== -1) return degreeMap['博士'];
			if (degree.indexOf('无学历') !== -1 || degree.indexOf('不限') !== -1) return degreeMap['无学历要求'];
			return '#999999';
		}

		// 时间格式化
		function formatJobTime(timeStr) {
			if (!timeStr) return { text: '', color: '#999999' };

			var date = new Date(timeStr);
			var now = new Date();
			var diff = now - date;
			var hours = Math.floor(diff / (1000 * 60 * 60));
			var days = Math.floor(diff / (1000 * 60 * 60 * 24));
			var months = Math.floor(diff / (1000 * 60 * 60 * 24 * 30));

			// 24小时以内 - 显示年月日时分秒（红色亮眼）
			if (hours < 24) {
				var year = date.getFullYear();
				var month = String(date.getMonth() + 1).padStart(2, '0');
				var day = String(date.getDate()).padStart(2, '0');
				var h = String(date.getHours()).padStart(2, '0');
				var m = String(date.getMinutes()).padStart(2, '0');
				var s = String(date.getSeconds()).padStart(2, '0');
				var text = year + '-' + month + '-' + day + ' ' + h + ':' + m + ':' + s;
				return { text: text, color: '#FF3B30' };
			}

			// 3天内 - 显示年月日（黄色）
			if (days <= 3) {
				var year = date.getFullYear();
				var month = String(date.getMonth() + 1).padStart(2, '0');
				var day = String(date.getDate()).padStart(2, '0');
				var text = year + '-' + month + '-' + day;
				return { text: text, color: '#FFCC00' };
			}

			// 大于3天 - 显示X天前（灰色）
			if (days < 30) {
				return { text: days + '天前', color: '#999999' };
			}

			// 一个月以上 - 黑色
			if (months >= 1) {
				return { text: months + '个月前', color: '#333333' };
			}

			return { text: date.toLocaleDateString(), color: '#333333' };
		}

		// UI 创建
		function createBadge(text, color) {
			return '<span class="kxb-badge" style="display:inline-block;margin-right:8px;padding:3px 8px;background:' + color + ';color:white;border-radius:4px;font-size:12px;font-weight:500;">' + text + '</span>';
		}

		function create51jobBlacklistBadge(result) {
			if (result.found) {
				return '<a class="kxb-blacklist-badge" target="_blank" href="' + result.href + '" style="display:inline-block;margin-left:8px;padding:3px 8px;background:#F56C6C;color:white;border-radius:4px;font-size:12px;font-weight:500;text-decoration:none;cursor:pointer;">⚠️ 若比邻黑名单</a>';
			} else {
				return '<a class="kxb-blacklist-badge" target="_blank" href="' + result.searchUrl + '" style="display:inline-block;margin-left:8px;padding:3px 8px;background:#409EFF;color:white;border-radius:4px;font-size:12px;font-weight:500;text-decoration:none;cursor:pointer;">🔍 去搜索一下</a>';
			}
		}

		// 岗位处理
		function process51jobJobCard(jobElement) {
			try {
				var jobInfo = extractJobInfo(jobElement);
				if (!jobInfo || processedJobs[jobInfo.jobId]) return;

				processedJobs[jobInfo.jobId] = true;

				var jnameElement = jobElement.querySelector('.jname');
				if (!jnameElement) return;

				// 添加隐藏信息
				var infoHtml = '<div class="kxb-info-display" style="display:inline-block;margin-left:12px;vertical-align:middle;">';

				if (jobInfo.jobTime) {
					var timeInfo = formatJobTime(jobInfo.jobTime);
					infoHtml += createBadge(timeInfo.text, timeInfo.color);
				}

				if (jobInfo.jobDegree) {
					var degreeColor = getDegreeColor(jobInfo.jobDegree);
					infoHtml += createBadge(jobInfo.jobDegree, degreeColor);
				}

				if (jobInfo.jobYear) {
					var experienceColor = getExperienceColor(jobInfo.jobYear);
					infoHtml += createBadge(jobInfo.jobYear, experienceColor);
				}

				infoHtml += '</div>';

				if (jnameElement.nextElementSibling && jnameElement.nextElementSibling.className === 'kxb-info-display') {
					return;
				}

				var infoDiv = document.createElement('div');
				infoDiv.className = 'kxb-info-display';
				infoDiv.innerHTML = infoHtml;
				infoDiv.style.display = 'inline-block';
				jnameElement.parentNode.insertBefore(infoDiv, jnameElement.nextSibling);

				// 添加黑名单
				var companyName = extract51jobCompanyName(jobElement);
				if (companyName) {
					var cnameElement = jobElement.querySelector('.cname');
					if (cnameElement) {
						var existingBadge = cnameElement.parentNode.querySelector('.kxb-blacklist-badge');
						if (!existingBadge) {
							queryBlacklist(companyName).then(function (result) {
								var existingBadge = cnameElement.parentNode.querySelector('.kxb-blacklist-badge');
								if (existingBadge) return;

								var badge = create51jobBlacklistBadge(result);
								var badgeDiv = document.createElement('div');
								badgeDiv.innerHTML = badge;
								badgeDiv.style.display = 'inline-block';
								cnameElement.parentNode.insertBefore(badgeDiv, cnameElement.nextSibling);
							}).catch(function (error) {
								console.error('51job 黑名单查询错误:', error);
							});
						}
					}
				}

			} catch (e) {
				console.error('处理 51job 岗位卡片错误:', e);
			}
		}

		function scan51jobJobCards() {
			var jobElements = document.querySelectorAll('[sensorsname="JobShortExposure"]');
			jobElements.forEach(function (element) {
				process51jobJobCard(element);
			});
		}

		function clear51jobProcessedJobs() {
			processedJobs = {};
			var infoDivs = document.querySelectorAll('.kxb-info-display');
			infoDivs.forEach(function (div) {
				div.remove();
			});
			var badges = document.querySelectorAll('.kxb-blacklist-badge');
			badges.forEach(function (badge) {
				badge.parentNode.remove();
			});
		}

		function refresh51jobAllJobs() {
			clear51jobProcessedJobs();
			scan51jobJobCards();
		}

		// 控制窗口
		function create51jobControlPanel() {
			var panel = document.createElement('div');
			panel.id = 'kxb-control-panel';
			panel.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;width:320px;background:rgba(16,18,27,.96);color:#d8e1ff;border:1px solid rgba(123,145,255,.45);border-radius:10px;box-shadow:0 12px 36px rgba(0,0,0,.35);font-size:12px;line-height:1.4;overflow:hidden;font-family:Arial,sans-serif;';

			panel.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:12px;background:rgba(255,255,255,.06);cursor:move;user-select:none;border-bottom:1px solid rgba(255,255,255,.08);"><strong style="flex:1;">公司信息查询</strong><button type="button" data-action="minimize" style="all:unset;cursor:pointer;padding:4px 8px;border:1px solid rgba(255,255,255,.25);border-radius:4px;font-size:11px;">−</button><button type="button" data-action="close" style="all:unset;cursor:pointer;padding:4px 8px;border:1px solid rgba(255,255,255,.25);border-radius:4px;font-size:11px;">×</button></div><div id="kxb-panel-content" style="padding:12px;"><button type="button" data-action="refresh-info" style="width:100%;padding:8px;background:#FF3B30;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:bold;">🔄 刷新岗位信息</button></div>';

			document.body.appendChild(panel);
			controlPanel = panel;

			// 事件绑定
			var refreshInfoBtn = panel.querySelector('[data-action="refresh-info"]');
			var minimizeBtn = panel.querySelector('[data-action="minimize"]');
			var closeBtn = panel.querySelector('[data-action="close"]');

			if (refreshInfoBtn) {
				refreshInfoBtn.onclick = function () {
					clear51jobProcessedJobs();
					scan51jobJobCards();
				};
			}

			if (minimizeBtn) {
				minimizeBtn.onclick = function (e) {
					e.stopPropagation();
					var content = panel.querySelector('#kxb-panel-content');
					if (content.style.display === 'none') {
						content.style.display = 'block';
					} else {
						content.style.display = 'none';
					}
				};
			}

			if (closeBtn) {
				closeBtn.onclick = function (e) {
					e.stopPropagation();
					panel.style.display = 'none';
				};
			}

			// 拖动功能
			var headerDiv = panel.querySelector('[data-action="minimize"]').parentElement;
			if (headerDiv) {
				enable51jobDrag(panel, headerDiv);
			}

			update51jobControlPanel();
		}


		function enable51jobDrag(element, handle) {
			var dragging = false;
			var offsetX = 0;
			var offsetY = 0;

			handle.addEventListener('mousedown', function (event) {
				dragging = true;
				offsetX = event.clientX - element.getBoundingClientRect().left;
				offsetY = event.clientY - element.getBoundingClientRect().top;
				element.style.right = 'auto';
				element.style.bottom = 'auto';
				element.style.left = element.getBoundingClientRect().left + 'px';
				element.style.top = element.getBoundingClientRect().top + 'px';
				event.preventDefault();
			});

			document.addEventListener('mousemove', function (event) {
				if (!dragging) return;
				var left = Math.max(0, Math.min(window.innerWidth - 80, event.clientX - offsetX));
				var top = Math.max(0, Math.min(window.innerHeight - 80, event.clientY - offsetY));
				element.style.left = left + 'px';
				element.style.top = top + 'px';
			});

			document.addEventListener('mouseup', function () {
				dragging = false;
			});
		}

		// 初始化
		if (document.body) {
			setTimeout(function () {
				scan51jobJobCards();
				create51jobControlPanel();

				setTimeout(function () {
					refresh51jobAllJobs();
				}, 2000);
			}, 500);
		} else {
			document.addEventListener('DOMContentLoaded', function () {
				setTimeout(function () {
					scan51jobJobCards();
					create51jobControlPanel();

					setTimeout(function () {
						refresh51jobAllJobs();
					}, 2000);
				}, 500);
			});
		}

		// 监听 DOM 变化
		var listContainer = document.querySelector('[class*="joblist"]') || document.body;
		var observer = new MutationObserver(function () {
			scan51jobJobCards();
		});

		observer.observe(listContainer, {
			childList: true,
			subtree: true,
			attributes: false,
			characterData: false
		});

		// 清理
		window.addEventListener('beforeunload', function () {
			observer.disconnect();
		});

	}

	// 启动日志
	console.log('脚本启动');

})();
