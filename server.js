'use strict';

// ===== packages ===== //
const express = require('express');
const superagent = require('superagent');
require('dotenv').config();
const methodOverride = require('method-override');
const pg = require('pg');
const googleTrends = require('google-trends-api');
const puppeteer = require('puppeteer');


// ===== setup the app ===== //
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.static('./public'));
app.use(methodOverride('_method'));
const DATABASE_URL = process.env.DATABASE_URL;
const client = new pg.Client(DATABASE_URL);


// ===== other global variables ===== //
const PORT = process.env.PORT || 3111;
let browser = null;

// ===== Routes ===== //
app.get('/', getHomeData);
app.post('/search', getSearch);
app.get('/about', getAbout);
app.get('/saved-results', getSavedResults);
app.post('/save', save);
app.delete('/save/:id', deleteSaved);


// ===== Route Callback Functions ===== //
function getHomeData(req, res) {
  // renders index page and search form
  // -> index.ejs
  res.render('./pages/index.ejs', { novusIdeam: [] });
}

async function getSearch(req, res) {
  // gets results from the submission of search form, populates results table
  // -> index.ejs

  //  TODO: add loading page to index.ejs
  const reqBody = req.body;
  const keyword = req.body.searchQuery
  let resultNums = [];

  const googleTrendArray = await googleTrendsData(reqBody);
  let valueMapArray = googleTrendArray.map(value => value.query);
  valueMapArray = valueMapArray.slice(0, 5);

  const domainSuggestions = await domain(valueMapArray);
  resultNums = await scraper(valueMapArray);

  let newArr = googleTrendArray.slice(0, 5).map((trendQuery, index) => {
    return new NovusIdeam(keyword, resultNums[index], trendQuery, domainSuggestions[index]);
  });

  res.render('./pages/index.ejs', { novusIdeam: newArr });
}

function getAbout(req, res) {
  // send the user to the about page
  // -> about.ejs
  res.render('./pages/about.ejs');
}

function save(req, res) {
  // saving the the search results to the DB
  // redirect to /saved-results?

  // takes an 'ideam' object via POST on /search
  const ideam = req.body
  const sqlQuery = `INSERT INTO searches (keyword, google_results_count, niche_score) VALUES ($1, $2, $3) RETURNING id;`;
  const sqlArray = [ideam.googleTrendQuery, ideam.scraperNum, ideam.nicheScore]
  return client.query(sqlQuery, sqlArray).then(() => {
    console.log(`added ${ideam.googleTrendQuery} to database`);
    // TODO: notify user that ideam has been addedto database (using js to turn item blue?)
    res.redirect('/saved-results');

  }).catch(error => {
    res.status(500).render('pages/error.ejs');
    console.log(error.message);
  });
}

function deleteSaved(req, res) {
  // delete saved query
  // -> saved.ejs

  // takes DELETE on route /saved/:id 
  const id = req.params.id;
  console.log(id);
  // query db to delete item
  const sqlQuery = `DELETE FROM searches WHERE id = $1;`;
  const sqlArray = [id];
  return client.query(sqlQuery, sqlArray).then(() => {
    console.log(`deleted row ${id}`);
    res.redirect('/saved-results');
  }).catch(error => {
    res.status(500).render('pages/error.ejs');
    console.log(error.message);
  });
}

function getSavedResults(req, res) {
  // take the user to the saved results page. 
  // -> saved.ejs

  // Query SQL db for all saved searches
  const sqlQuery = `SELECT * FROM searches ORDER BY niche_score;`;
  return client.query(sqlQuery).then(result => {
    res.render('pages/saved.ejs', { results: result.rows }); // Passes 'results' to saved.ejs
  }).catch(error => {
    res.status(500).render('pages/error.ejs');
    console.log(error.message);
  });
}

// ===== Helper Functions ===== // 
async function domain(array) {
  // Gets related avaiable domain names from Domain API
  const regex = /\.ru|\.xxx|\.se|\.de|\.dk|\.za|\.fr|\.au|\.ch|(sex)|(porno)|(fuck)|(cock)/g;
  const domainArrayofArrays = [];
  for (let i = 0; i < array.length; i++) {
    const googleTrendword = array[i];

    const domainUrl = `https://api.domainsdb.info/v1/domains/search?&limit=5&country=us&domain=${googleTrendword}`;
    domainArrayofArrays.push(superagent.get(domainUrl));
  }
  return Promise.all(domainArrayofArrays).then(search => {
    const array = [];
    for (let i = 0; i < search.length; i++) {
      const container = [];
      const thing = search[i].body.domains;
      for (let j = 0; j < thing.length; j++) {
        if (!regex.test(thing[j].domain)) {
          container.push(thing[j].domain);
        }
      }
      array.push(container);
    }
    return array;
  });
}

async function googleTrendsData(reqBody) {
  // usage: googleTrends.relatedQueries({keyword: string, startTime: Date, endTime: Date, geo: string}, cbFunc)
  const keyword = reqBody.searchQuery;
  const startTime = new Date(reqBody.startTime);
  const endTime = new Date(reqBody.endTime);
  const geo = reqBody.geo.toUpperCase();
  return await googleTrends.relatedQueries({ keyword: keyword, startTime: startTime, endTime: endTime, geo: geo })
    .then(results => {
      const parsedResults = JSON.parse(results);
      // possible create a toggle button that switches from 0 to 1 based on what the user is looking for.
      const relatedKeyword = parsedResults.default.rankedList[0].rankedKeyword;
      console.log(relatedKeyword);
      return relatedKeyword;
    }).catch(error => {
      console.log(error.message);
    });
}

// ***Chance Harmon wrote most of the below scraper function with reference to https://www.youtube.com/watch?v=4q9CNtwdawA ***
//  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all
async function getBrowser() {
  // Starts up Puppeteer browser instance if not already running
  if (browser === null) {
    browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  }
  return browser;
}
async function scraper(keywords) {
  // scrapes google.com/query for given serach query, returns total number of results found (as string)
  console.time('scrape');
  const scraperPromises = keywords.map(keyword => {
    const url = `https://www.google.com/search?q=${keyword}`;
    let page;
    return getBrowser()
      // start up browser instance if not already started
      .then((browser) => {
        return browser.newPage()
        // start new browser tab instance
      })
      .then((newPage) => {
        page = newPage;
        return page.goto(url, { waitUntil: 'domcontentloaded' });
        // load given url on tab
      })
      .then(() => {
        return page.evaluate(() => {
          return document.querySelector('#result-stats').textContent;
          // grab #result-stats object from rendered html. contains total search results
        })
          .catch(error => (null))
        // if loading error, return null
      })
      .then((countResult) => {
        if (countResult === null) {
          return null;
        }
        // regex for pulling Number from string of "results:..."
        const string = countResult;
        const regex = /[0-9,]+/;
        return parseInt(regex.exec(string)[0].replace(/,/g, ''));
      })
      // Lastly, kill the page
      .finally(() => page.close());
  })
  const counts = await Promise.all(scraperPromises).catch(console.log);
  // runs all Puppeteer pages simultaneously, returns promise results to counts
  console.timeEnd('scrape');
  return counts;
}

// ===== other functions ===== //
function NovusIdeam(keyword, scraperNum, googleTrendQuery, suggestedDomain) {
  // Ideam constructor build 'Ideam' object
  this.keyword = keyword,
    this.googleTrendQuery = googleTrendQuery.query,
    this.scraperNum = scraperNum,
    this.nicheScore = Math.floor(scraperNum / googleTrendQuery.value / 10000),
    this.suggestedDomain = suggestedDomain
}

// TODO: refactor error functions
// function errorFn(error) {
//   console.error('Oh no there was an error', error);
// }

// ===== start the server ===== //
client.connect() // Starts connection to postgres 
  .then(() => {
    app.listen(PORT, () => console.log(`up on PORT ${PORT}`));
  });