
import * as cache from '../../config/cache'
import * as syntax from '../../config/syntax'
import * as pattern from '../../config/pattern'

import Context from '../helper/Context'
import Scanner from '../helper/Scanner'

import Attribute from '../node/Attribute'
import Directive from '../node/Directive'
import Each from '../node/Each'
import Element from '../node/Element'
import Else from '../node/Else'
import ElseIf from '../node/ElseIf'
import Expression from '../node/Expression'
import If from '../node/If'
import Import from '../node/Import'
import Partial from '../node/Partial'
import Text from '../node/Text'

import {
  IF,
  ELSE_IF,
  ELSE,
  EACH,
  DIRECTIVE,
  EXPRESSION,
  IMPORT,
  PARTIAL,
  TEXT,
  ELEMENT,
  ATTRIBUTE,
} from '../nodeType'

import {
  isArray,
  isString,
  isFunction,
} from '../../util/is'

import {
  each,
  lastItem,
} from '../../util/array'

import {
  parseError,
  isBreakLine,
  trimBreakline,
} from '../../util/string'

import {
  parse as parseExpression,
} from '../../util/expression'

const openingDelimiterPattern = /\{\{\s*/
const closingDelimiterPattern = /\s*\}\}/

const elementPattern = /<(?:\/)?[a-z]\w*/i
const elementEndPattern = /(?:\/)?>/

const attributeSuffixPattern = /^([^"']*)["']/
const attributePattern = /([-:@a-z0-9]+)(?:=(["'])(?:([^'"]*))?)/i
const attributeValueStartPattern = /^=["']/

const parsers = [
  {
    test: function (source) {
      return source.startsWith(syntax.EACH)
    },
    create: function (source) {
      let terms = source.substr(syntax.EACH.length).trim().split(':')
      let name = terms[0].trim()
      let index
      if (terms[1]) {
        index = terms[1].trim()
      }
      return new Each(name, index)
    }
  },
  {
    test: function (source) {
       return source.startsWith(syntax.IMPORT)
    },
    create: function (source) {
      let name = source.substr(syntax.IMPORT.length).trim()
      if (name) {
        return new Import(name)
      }
    }
  },
  {
    test: function (source) {
       return source.startsWith(syntax.PARTIAL)
    },
    create: function (source) {
      let name = source.substr(syntax.PARTIAL.length).trim()
      if (name) {
        return new Partial(name)
      }
      throw new Error('模板片段缺少名称')
    }
  },
  {
    test: function (source) {
       return source.startsWith(syntax.IF)
    },
    create: function (source) {
      let expr = source.substr(syntax.IF.length).trim()
      if (expr) {
        return new If(parseExpression(expr))
      }
      throw new Error('if 缺少条件')
    }
  },
  {
    test: function (source) {
      return source.startsWith(syntax.ELSE_IF)
    },
    create: function (source, popStack) {
      let expr = source.substr(syntax.ELSE_IF.length)
      if (expr) {
        popStack()
        return new ElseIf(parseExpression(expr))
      }
      throw new Error('else if 缺少条件')
    }
  },
  {
    test: function (source) {
      return source.startsWith(syntax.ELSE)
    },
    create: function (source, popStack) {
      popStack()
      return new Else()
    }
  },
  {
    test: function (source) {
      return true
    },
    create: function (source) {
      let safe = true
      if (source.startsWith('{')) {
        safe = false
        source = source.substr(1)
      }
      return new Expression(parseExpression(source), safe)
    }
  }
]

const rootName = 'root'

/**
 * 把抽象语法树渲染成 Virtual DOM
 *
 * @param {Object} ast
 * @param {Object} data
 * @return {Object}
 */
export function render(ast, data) {

  let rootElement = new Element(rootName)
  let rootContext = new Context(data)
  let keys = [ ]

  // 在渲染语法树的过程中，如果发现 Element 节点是一个组件
  // 则在节点上绑定一个 create 函数
  // 在第一次渲染元素时，调用该函数，并把组件实例绑定组件元素上
  // 当组件元素销毁时，连带销毁组件实例

  // 非转义插值需要解析模板字符串
  let parseTemplate = function (template) {
    return parse(template).children
  }

  if (ast.name === rootName) {
    each(
      ast.children,
      function (child) {
        child.render(rootElement, rootContext, keys, parseTemplate)
      }
    )
  }
  else {
    ast.render(rootElement, rootContext, keys, parseTemplate)
  }

  let { children } = rootElement
  if (children.length !== 1 || children[0].type !== ELEMENT) {
    throw new Error('组件有且只能有一个根元素')
  }

  return children[0]

}

/**
 * 把模板解析为抽象语法树
 *
 * @param {string} template
 * @param {Function} getPartial 当解析到 IMPORT 节点时，需要获取模板片段
 * @param {Function} setPartial 当解析到 PARTIAL 节点时，需要注册模板片段
 * @return {Object}
 */
export function parse(template, getPartial, setPartial) {

  let { templateParseCache } = cache

  if (templateParseCache[template]) {
    return templateParseCache[template]
  }

  let mainScanner = new Scanner(template), helperScanner = new Scanner()
  let rootNode = new Element(rootName), currentNode = rootNode, lastNode, node
  let name, value, content, isComponent, isDirective, isAttributesParsing, match, errorPos
  let nodeStack = []

  let pushStack = function (node) {
    nodeStack.push(currentNode)
    currentNode = node
  }

  let popStack = function () {
    currentNode = nodeStack.pop()
    return currentNode
  }

  let addChild = function (node) {

    let { name, type, content, children } = node

    switch (type) {
      case TEXT:
        if (isBreakLine(content)) {
          return
        }
        if (content = trimBreakline(content)) {
          node.content = content
        }
        else {
          return
        }
        break

      case EXPRESSION:
        if (isAttributesParsing && currentNode.type !== ATTRIBUTE) {
          addChild(
            new Attribute(node)
          )
          return
        }
        break

      case IMPORT:
        each(
          getPartial(name).children,
          addChild
        )
        return

      case PARTIAL:
        setPartial(name, node)
        return

    }

    let action = 'addChild'
    if (currentNode.type === ELEMENT && isAttributesParsing) {
      if (node.type === DIRECTIVE) {
        action = 'addDirective'
      }
      else if (node.type === ATTRIBUTE) {
        action = 'addAttr'
      }
    }

    currentNode[action](node)

    if (children) {
      pushStack(node)
    }
  }

  // 这个函数涉及分隔符和普通模板的深度解析
  // 是最核心的函数
  let parseContent = function (content) {

    helperScanner.reset(content)

    while (helperScanner.hasNext()) {

      // 分隔符之前的内容
      content = helperScanner.nextBefore(openingDelimiterPattern)
      helperScanner.nextAfter(openingDelimiterPattern)

      if (content) {

        // 支持以下 5 种 attribute
        // name
        // {{name}}
        // name="value"
        // name="{{value}}"
        // {{name}}="{{value}}"

        if (isAttributesParsing) {

          // 当前节点是 ATTRIBUTE
          // 表示至少已经有了属性名
          if (currentNode.type === ATTRIBUTE) {

            // 走进这里，只可能是以下几种情况
            // 1. 属性名是字面量，属性值已包含表达式
            // 2. 属性名是表达式，属性值不确定是否存在

            // 当前属性的属性值是字面量结尾
            if (currentNode.children.length) {
              if (match = content.match(attributeSuffixPattern)) {
                value = match[1]
                if (value) {
                  addChild(
                    new Text(value)
                  )
                }
                content = content.replace(attributeSuffixPattern, '')
                popStack()
              }
            }
            else {
              // 属性值开头部分是字面量
              if (attributeValueStartPattern.test(content)) {
                content = content.replace(attributeValueStartPattern, '')
              }
              // 没有属性值
              else {
                popStack()
              }
            }

          }

          if (currentNode.type !== ATTRIBUTE) {
            // 下一个属性的开始
            while (match = attributePattern.exec(content)) {
              content = content.substr(match.index + match[0].length)

              name = match[1]
              value = match[3]

              isDirective = name.startsWith(syntax.DIRECTIVE_PREFIX)
                || name.startsWith(syntax.DIRECTIVE_EVENT_PREFIX)

              addChild(
                isDirective
                ? new Directive(name)
                : new Attribute(name)
              )

              if (isString(value)) {
                addChild(
                  new Text(value)
                )
                // 剩下的只可能是引号了
                if (content) {
                  popStack()
                }
                // else 可能跟了一个表达式
              }
              // 如 checked、disabled
              else {
                popStack()
              }
            }
            content = ''
          }
        }

        if (content) {
          addChild(
            new Text(content)
          )
        }
      }

      // 分隔符之间的内容
      content = helperScanner.nextBefore(closingDelimiterPattern)
      helperScanner.nextAfter(closingDelimiterPattern)

      if (content) {
        if (content.charAt(0) === '/') {
          popStack()
        }
        else {
          if (content.charAt(0) === '{' && helperScanner.charAt(0) === '}') {
            helperScanner.forward(1)
          }
          each(
            parsers,
            function (parser) {
              if (parser.test(content)) {
                addChild(
                  parser.create(content, popStack)
                )
                return false
              }
            }
          )
        }
      }

    }
  }

  while (mainScanner.hasNext()) {
    content = mainScanner.nextBefore(elementPattern)

    if (content.trim()) {
      // 处理标签之间的内容
      parseContent(content)
    }

    // 接下来必须是 < 开头（标签）
    // 如果不是标签，那就该结束了
    if (mainScanner.charAt(0) !== '<') {
      break
    }

    errorPos = mainScanner.pos

    // 结束标签
    if (mainScanner.charAt(1) === '/') {
      content = mainScanner.nextAfter(elementPattern)
      name = content.substr(2)

      if (mainScanner.charAt(0) !== '>') {
        return parseError('结束标签缺少 >')
      }
      else if (name !== currentNode.name) {
        return parseError('开始标签和结束标签匹配失败')
      }

      popStack()
      mainScanner.forward(1)
    }
    // 开始标签
    else {
      content = mainScanner.nextAfter(elementPattern)
      name = content.substr(1)
      isComponent = pattern.componentName.test(name)

      // 低版本浏览器不支持自定义标签，因此需要转成 div
      addChild(
        new Element(
          isComponent ? 'div' : name,
          isComponent ? name : ''
        )
      )

      // 截取 <name 和 > 之间的内容
      // 用于提取 attribute
      content = mainScanner.nextBefore(elementEndPattern)
      if (content) {
        isAttributesParsing = true
        parseContent(content)
        isAttributesParsing = false
      }

      content = mainScanner.nextAfter(elementEndPattern)
      if (!content) {
        return parseError('标签缺少 >')
      }

      if (isComponent || pattern.selfClosingTagName.test(name)) {
        popStack()
      }
    }
  }

  if (nodeStack.length) {
    return parseError('节点没有正确的结束')
  }

  templateParseCache[template] = rootNode

  return rootNode

}