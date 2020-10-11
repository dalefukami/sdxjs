#!/usr/bin/env node

'use strict'

const argparse = require('argparse')
const assert = require('assert')
const ejs = require('ejs')
const glob = require('glob')
const fs = require('fs')
const MarkdownIt = require('markdown-it')
const MarkdownAnchor = require('markdown-it-anchor')
const matter = require('gray-matter')
const minimatch = require('minimatch')
const path = require('path')
const rimraf = require('rimraf')
const yaml = require('js-yaml')

/**
 * Default settings.
 */
const DEFAULTS = {
  configFile: 'config.yml',
  linksFile: 'links.yml',
  outputDir: 'docs',
  rootDir: '.'
}

/**
 * Files to copy directly.
 */
const COPY_FILES = ['.nojekyll', 'CNAME']

/**
 * File containing Markdown-formatted links.
 */
const LINKS_FILE = 'links.md'

/**
 * Header inclusion.
 */
const HEADER = "<%- include('/inc/head.html') %>"

/**
 * Footer inclusion.
 */
const FOOTER = "<%- include('/inc/foot.html') %>"

/**
 * Main driver.
 */
const main = () => {
  const config = getConfiguration()
  const linksText = buildLinks(config)
  const allFiles = buildFileInfo(config)
  loadFiles(allFiles)
  rimraf.sync(config.outputDir)
  allFiles.forEach(fileInfo => translateFile(config, fileInfo, linksText))
  finalize(config)
}

/**
 * Build program configuration.
 * @returns {Object} Program configuration.
 */
const getConfiguration = () => {
  const parser = new argparse.ArgumentParser()
  parser.add_argument('-c', '--configFile', {default: DEFAULTS.configFile})
  parser.add_argument('-l', '--linksFile', {default: DEFAULTS.linksFile})
  parser.add_argument('-o', '--outputDir', {default: DEFAULTS.outputDir})
  parser.add_argument('-r', '--rootDir', {default: DEFAULTS.rootDir})
  const fromArgs = parser.parse_args()

  const fromFile = yaml.safeLoad(fs.readFileSync(fromArgs.configFile))
  const config = {...fromArgs, ...fromFile}

  assert(config.linksFile,
         `Need a links file`)
  assert(config.outputDir,
         `Need a site directory`)
  assert(config.rootDir,
         `Need a root directory`)

  return config
}

/**
 * Build table of Markdown links to append to pages during translation.
 * @param {Object} config Configuration.
 * @returns {string} Table of links to append to all Markdown files.
 */
const buildLinks = (config) => {
  config.links = yaml.safeLoad(fs.readFileSync(config.linksFile))
  return config.links
    .map(entry => `[${entry.slug}]: ${entry.url}`)
    .join('\n')
}

/**
 * Extract files from configuration and decorate information records.
 * @param {Object} config Configuration.
 * @returns {Array<Object>} File information.
 */
const buildFileInfo = (config) => {
  // All files.
  const allFiles = [...config.extras, ...config.chapters, ...config.appendices]
  allFiles.forEach((fileInfo, i) => {
    assert('slug' in fileInfo,
           `Every page must have a slug ${Object.keys(fileInfo)}`)
    fileInfo.index = i
    if (!('source' in fileInfo)) {
      fileInfo.source = path.join(config.rootDir, fileInfo.slug, 'index.md')
    }
    if (!('output' in fileInfo)) {
      fileInfo.output = path.join(fileInfo.slug, 'index.html')
    }
  })

  // Numbered pages.
  const numbered = [...config.chapters, ...config.appendices]
  numbered.forEach((fileInfo, i) => {
    fileInfo.previous = (i > 0) ? numbered[i-1] : null
    fileInfo.next = (i < numbered.length-1) ? numbered[i+1] : null
  })

  return allFiles
}

/**
 * Load all files to be translated (so that cross-references can be built).
 * @param {Object} allFiles All files records.
 */
const loadFiles = (allFiles) => {
  allFiles.forEach((fileInfo, i) => {
    const {data, content} = matter(fs.readFileSync(fileInfo.source))
    Object.assign(fileInfo, data)
    fileInfo.content = `${HEADER}\n${content}\n${FOOTER}`
  })
}

/**
 * Translate and save each file.
 * @param {Object} config Program configuration.
 * @param {Object} fileInfo Information about file.
 * @param {string} linksText Markdown-formatted links table.
 */
const translateFile = (config, fileInfo, linksText) => {
  // Context contains variables required by EJS.
  const context = {
    root: config.rootDir,
    filename: fileInfo.source
  }

  // Settings contains "local" variables for rendering.
  const settings = {
    ...context,
    site: config,
    page: fileInfo,
    toRoot: toRoot(fileInfo.output),
    _codeClass,
    _exercise,
    _readFile,
    _readPage
  }

  // Since inclusions may contain inclusions, we need to provide the rendering
  // function to the renderer in the settings.
  settings['_render'] = (text) => ejs.render(text, settings, context)

  // Translate the page.
  const translated = settings['_render'](`${fileInfo.content}\n\n${linksText}`)
  const mdi = new MarkdownIt({html: true})
        .use(MarkdownAnchor, {level: 1, slugify: slugify})
  const html = mdi.render(translated)

  // Save result.
  const outputPath = path.join(config.outputDir, fileInfo.output)
  ensureOutputDir(outputPath)
  fs.writeFileSync(outputPath, html, 'utf-8')
}

/**
 * Create class attribute of code inclusion.
 * @param {string} filename Name of file.
 * @returns {string} Class attribute.
 */
const _codeClass = (filename) => {
  return `language-${path.extname(filename).slice(1)}`
}

/**
 * Read exercise problem or solution for inclusion.
 * @param {function} render How to translate loaded file.
 * @param {string} root Path to root.
 * @param {Object} chapter Chapter information.
 * @param {Object} exercise Exercise information.
 * @param {string} which Either 'problem' or 'solution'
 */
const _exercise = (render, root, chapter, exercise, which) => {
  const title = `<h3 class="exercise">${exercise.title}</h3>`
  const path = `${root}/${chapter.slug}/${exercise.slug}/${which}.md`
  const contents = render(fs.readFileSync(path, 'utf-8'))
  return `${title}\n\n${contents}\n`
}

/**
 * Read file for code inclusion.
 * @param {string} mainFile Name of file doing the inclusion.
 * @param {string} subFile Name of file being included.
 * @returns {string} File contents (possibly with minimal HTML escaping).
 */
const _readFile = (mainFile, subFile) => {
  return fs.readFileSync(`${path.dirname(mainFile)}/${subFile}`, 'utf-8')
    .replace(/&/g, '&amp;')
    .replace(/>/g, '&gt;')
    .replace(/</g, '&lt;')
}

/**
 * Read HTML page for inclusion.
 * @param {string} mainFile Name of file doing the inclusion.
 * @param {string} subFile Name of file being included.
 * @returns {string} Contents of body.
 */
const _readPage = (mainFile, subFile) => {
  const content = fs.readFileSync(`${path.dirname(mainFile)}/${subFile}`, 'utf-8')
  // FIXME: extract body
  return content
}

/**
 * Turn title text into anchor.
 * @param {string} text Input text
 * @returns {string} slug
 */
const slugify = (text) => {
  return encodeURIComponent(text.trim()
                            .toLowerCase()
                            .replace(/[^ \w]/g, '')
                            .replace(/\s+/g, '-'))
}

/**
 * Copy static files and save numbering data.
 * @param {Object} config Configuration.
 */
const finalize = (config) => {
  // Simple files.
  const excludes = config.exclude.map(pattern => new minimatch.Minimatch(pattern))
  const toCopy = config.copy
        .map(pattern => path.join(config.rootDir, pattern))
        .map(pattern => glob.sync(pattern))
        .flat()
        .filter(filename => !excludes.some(pattern => pattern.match(filename)))
  toCopy.forEach(source => {
    const dest = makeOutputPath(config.outputDir, source)
    ensureOutputDir(dest)
    fs.copyFileSync(source, dest)
  })

  // Numbering.
  const numbering = buildNumbering(config)
  fs.writeFileSync(path.join(config.outputDir, 'numbering.js'),
                   JSON.stringify(numbering, null, 2),
                   'utf-8')
}

/**
 * Build numbering lookup table for chapters and appendices.
 * @param {Object} config Configuration.
 * @returns {Object} slug-to-number-or-letter lookup table.
 */
const buildNumbering = (config) => {
  const result = {}
  const numbered = [...config.extras, ...config.chapters]
  numbered.forEach((fileInfo, i) => {
    result[fileInfo.slug] = `${i+1}`
  })
  const start = 'A'.charCodeAt(0)
  config.appendices.forEach((fileInfo, i) => {
    result[fileInfo.slug] = String.fromCharCode(start + i)
  })
  return result
}

/**
 * Construct output filename.
 * @param {string} output Output directory.
 * @param {string} source Source file path.
 * @param {Object} suffixes Lookup table for suffix substitution.
 * @returns {string} Output file path.
 */
const makeOutputPath = (output, source, suffixes={}) => {
  let dest = path.join(output, source)
  const ext = path.extname(dest)
  if (ext in suffixes) {
    dest = dest.slice(0, dest.lastIndexOf(ext)) + suffixes[ext]
  }
  return dest
}

/**
 * Ensure output directory exists.
 * @param {string} outputPath File path.
 */
const ensureOutputDir = (outputPath) => {
  const dirName = path.dirname(outputPath)
  fs.mkdirSync(dirName, {recursive: true})
}

/**
 * Calculate the relative root path.
 * @param {string} filePath Path to file.
 * @returns {string} Path from file to root directory.
 */
const toRoot = (filePath) => {
  const dirPath = path.dirname(filePath)
  return (dirPath === '.') ? '.' : dirPath.split('/').map(x => '..').join('/')
}

// Run program.
main()
