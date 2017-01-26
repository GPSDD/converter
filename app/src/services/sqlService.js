'use strict';

var simpleSqlParser = require('simple-sql-parser');
var logger = require('logger');
var JSONAPIDeserializer = require('jsonapi-serializer').Deserializer;
const Sql2json = require('sql2json').sql2json;
const Json2sql = require('sql2json').json2sql;

var deserializer = function(obj) {
  return function(callback) {
    new JSONAPIDeserializer({
      keyForAttribute: 'camelCase'
    }).deserialize(obj, callback);
  };
};


class SQLService {
  static generateError(message) {
    logger.debug(message);
    return {
      error: true,
      message: `${message}`
    };
  }

  static correctSQL(ast) {
    if (ast.type !== 'select' && ast.type !== 'delete') {
      return SQLService.generateError(`Type ${ast.type} not allowed`);
    }
    if ((ast.join && ast.join.length > 0) || (ast.from && ast.from.length > 1)) {
      return SQLService.generateError(`Joins not allowed`);
    }
    return {
      error: false
    };
  }

  static checkSQL(parsed) {
    logger.info('Checking sql ');
    if (parsed && parsed.select && parsed.select.length > 0 && parsed.from) {
      return {
        error: false
      };
    }
    return  SQLService.generateError('Malformed query');
  }

  static obtainASTFromSQL(sql) {
    let ast = simpleSqlParser.sql2ast(sql);
    if (!ast.status) {
      return SQLService.generateError('Malformed query');
    }
    return {
      error: false,
      ast: ast.value
    };
  }

  static * obtainGeoStore(id) {
    try {
      let result = yield require('ct-register-microservice-node').requestToMicroservice({
        uri: encodeURI(`/geostore/${id}`),
        method: 'GET',
        json: true
      });
      
      let geostore = yield deserializer(result);
      if (geostore) {
        return geostore;
      }
    } catch(err){
      logger.error('Error obtaining geostore', err);
      if (err && err.statusCode === 404) {
        throw new Error('Geostore not found');
      } 
      throw new Error('Error obtaining geostore');
    }
  }

  static * sql2SQL(data) {
    logger.debug('Converting sql to sql', data);
    let parsed = new Sql2json(data.sql).toJSON();
    if (!parsed) {
      return SQLService.generateError('Malformed query');
    }
    if (data.geostore) {
      logger.debug('Contain geostore. Obtaining geojson');
      let geostore = yield SQLService.obtainGeoStore(data.geostore);
      logger.debug('Completing query');

      const intersect = {
        type: 'function',
        value: 'ST_INTERSECTS',
        arguments: [{
          type: 'function',
          value: 'ST_SetSRID',
          arguments: [{
            type: 'function',
            value: 'ST_GeomFromGeoJSON',
            arguments: [{
              type: 'string',
              value: JSON.stringify(geostore.geojson.features[0].geometry)
            }],
          }, {
            type: 'number',
            value: 4326
          }]
        }, {
          type: 'literal',
          value: 'the_geom'
        }]
      };

      if (parsed.where) {
        parsed.where = {
          type: 'conditional',
          value: 'and',
          left: intersect,
          right: parsed.where
        };
      }
    }
    logger.debug('sql converted!');

    const result = SQLService.checkSQL(parsed);
    if (!result || result.error) {
      return result;
    }
    return {
      sql: Json2sql.toSQL(parsed),
      parsed
    };
  }
}

module.exports = SQLService;  
