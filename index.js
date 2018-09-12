/**
 * 适配 vue 组件
 * @author ydr.me
 * @create 2018年09月11日12:51:57
 * @update 2018年09月12日15:14:57
 */


'use strict';

var debug = require('blear.node.debug');
var array = require('blear.utils.array');
var object = require('blear.utils.object');
var random = require('blear.utils.random');
var fs = require('fs');
var uglify = require("uglify-js");
var compiler = require('vue-template-compiler');
var transpile = require('vue-template-es2015-compiler');

var pkg = require('./package.json');
var path = require('path');

var coolievueRE = /^\s*@coolievue\s*$/i;
var defaults = {};


module.exports = function () {
    return [
        rewriteVueRuntimeMode(),
        rewriteVueComponentProperty()
    ];
};
module.exports.package = pkg;
module.exports.defaults = defaults;

// ====================================

/**
 * 重写 vue.runtime 模式
 * @returns {Function}
 */
function rewriteVueRuntimeMode() {
    var rewriter = {
        'node_modules/vue/dist/vue.common.js': 'node_modules/vue/dist/vue.runtime.common.js'
    };
    var rewriterLocal = {};

    return function (options) {
        // 相对文件路径 => 静态文件路径
        if (options.progress === 'post-config') {
            object.each(rewriter, function (from, to) {
                from = path.join(options.configs.srcDirname, from);
                to = path.join(options.configs.srcDirname, to);
                rewriterLocal[from] = to;
            });
            return options;
        }

        // 替换 完整版本 => 运行时版本
        if (options.progress === 'post-module' && options.nodeModule === true) {
            if (rewriterLocal[options.file]) {
                options.file = rewriterLocal[options.file];
            }

            return options;
        }
    };
}


/**
 * 重写 vue 组件属性
 * @returns {Function}
 */
function rewriteVueComponentProperty() {
    var coolieConfigs = null;
    var virtualFileMap = {};

    return function (options) {
        var coolie = this;
        var walkTemplateProperty = function (node) {
            // 前注释必须包含 @coolievue
            var match = hasCoolievueComment(node.start.comments_before);
            var right = null;
            var startPos = 0;
            var endPos = 0;
            var type = 0;

            // template 等号属性
            if (
                match &&
                node.body && node.body.operator === '=' &&
                node.body.left && node.body.left.property === 'template'
            ) {
                right = node.body.right;
                startPos = node.body.left.end.pos;
                endPos = node.body.right.end.endpos;
                type = 1;
            }
            // template 冒号属性
            else if (
                match &&
                node.key === 'template'
            ) {
                right = node.value;
                startPos = node.start.pos;
                endPos = node.end.endpos;
                type = 2;
            }

            var args = null;
            if (
                right &&
                right.expression &&
                right.expression.name === 'require' &&
                right.args &&
                right.args.length &&
                (right.args.length === 1 || right.args.length === 2)
            ) {
                args = right.args;
                replaceTemplateProperty(args, startPos, endPos, type);
            }
        };
        var hasCoolievueComment = function (comments) {
            var found = false;

            array.each(comments, function (index, comment) {
                if (coolievueRE.test(comment.value)) {
                    found = true;
                    return false;
                }
            });

            return found;
        };
        var replaceTemplateProperty = function (args, startPos, endPos, type) {
            var operator = {
                // type1: template = require('abc.html')
                1: ' = ',
                // type2: template: require('abc.html')
                2: ': '
            }[type];
            var arg0 = args[0];
            var arg1 = args[1];
            var res = coolie.resolveModule(
                arg0 && arg0.value,
                arg1 && arg1.value,
                {
                    file: options.file,
                    srcDirname: coolieConfigs.srcDirname
                }
            );

            if (res.inType === 'html' && res.outType === 'text') {
                var virtualName = generateVritualFile(res);
                var replacement = new uglify.AST_String({
                    value: virtualName,
                    quote: arg0.quote
                }).print_to_string({beautify: true});
                var before = options.code.slice(0, startPos);
                var after = options.code.slice(endPos);
                options.code = before + 'render' + operator + 'require(' + replacement + ')' + after;
                return;
            }

            debug.warn('coolie-mid-vue', options.file);
            debug.warn('coolie-mid-vue', 'template 属性的 require 管道类型仅支持 html|text');
        };
        var generateVritualFile = function (res) {
            var id = res.id;
            var virtualFile = virtualFileMap[id];
            var virtualName;

            // 已有虚拟文件缓存（即多个模块引用了同一个 vue template）
            // 尽管这种情况很少出现
            if (virtualFile) {
                virtualName = path.relative(path.dirname(options.file), virtualFile);

                if (!/^\.{1,2}\//.test(virtualName)) {
                    virtualName = './' + virtualName;
                }
            } else {
                virtualName = './[coolie-mid-vue-virtual-file]-' + random.guid() + '.js';
            }

            if (!virtualFileMap[id]) {
                var html = fs.readFileSync(id, 'utf8');
                var cop = compiler.compile(html);
                var data = toFunction(cop.render);
                var dir = path.dirname(id);
                virtualFile = path.join(dir, virtualName);
                coolie.virtualFile(
                    virtualFile,
                    'utf8',
                    'module.exports = ' + data + ';'
                );
                virtualFileMap[id] = virtualFile;
            }

            return virtualName;
        };

        // 相对文件路径 => 静态文件路径
        if (options.progress === 'post-config') {
            coolieConfigs = options.configs;
            return options;
        }

        // 模块解析，将 vue 组件的 template 属性转换为 render，
        // 并新增虚拟文件
        if (options.progress === 'pre-module' && options.nodeModule === false) {
            var ast = null;
            var toFunction = function (code) {
                return transpile('function render () {' + code + '}')
            };

            try {
                ast = uglify.parse(options.code);
            } catch (err) {
                debug.error('parse module', options.file);
                debug.error('parse module', '语法有误，无法解析，请检查。');
                debug.error('parse module', err.message);
                return;
            }

            ast.walk(new uglify.TreeWalker(walkTemplateProperty));
        }

        // do sth.
        return options;
    };
}

