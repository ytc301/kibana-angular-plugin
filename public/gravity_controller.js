define(function (require) {
  var angular = require('angular');
  var getSort = require('ui/doc_table/lib/get_sort');
  var dateMath = require('ui/utils/dateMath');

  require('ui/notify');

  var module = require('ui/modules').get('kibana/kibana-gravity', ['kibana']);
  module.service('gravityHelper', [function () {
    this.elasticHitToGravity = function(hit) {
      var gravity = {
        id: hit["_id"],
        fields: {}
      };

      Object.keys(hit._source).forEach(function (field) {
        gravity.fields[field] = hit["_source"][field];
      });

      return gravity;
    };
  }]);
  module.controller('KbnGravityVisController', function ($scope, $compile, $interpolate, $sce, $route, courier, Private, Promise, Notifier,
                                                         gravityHelper, savedSearches, timefilter, AppState) {
    var HitSortFn = Private(require('plugins/kibana/discover/_hit_sort_fn'));
    var notify = new Notifier({location: 'Gravity Widget'});
    var queryFilter = Private(require('ui/filter_bar/query_filter'));

    $scope.html = '<img src="{{gravity.fields.image}}" width="120" /> {{gravity.id}}';
    $scope.renderTemplate = function(gravity) {
      var html = $interpolate($scope.html)({gravity: gravity});
      return $sce.trustAsHtml(html);
    };
    $scope.$watch('vis.params.html', function (html) {
      if (!html) return;
      $scope.html = html;
    });

    $scope.hits = 0;
    $scope.gravities = [];
    $scope.route = $route;
    $scope.currentView =  $route.current.locals.dash != null ? "dashboard" : "edit";
    $scope.indexPattern = $scope.vis.indexPattern;
    $scope.state = new AppState();
    $scope.state.index = $scope.indexPattern.id;
    $scope.state.sort = getSort.array($scope.state.sort, $scope.indexPattern);
    savedSearches.get($scope.state.index).then(function (savedSearch) {
      $scope.searchSource = savedSearch.searchSource;

      $scope.searchSource.set('index', $scope.indexPattern);
      $scope.opts = {
        index: $scope.indexPattern.id,
        query: $scope.searchSource.get('query') || '',
        filters: _.cloneDeep($scope.searchSource.getOwn('filter')),
        sort: getSort.array(["time", "desc"], $scope.indexPattern),
        size: 10,
        timefield: $scope.indexPattern.timeFieldName
      };

      $scope.updateDataSource = Promise.method(function () {
        $scope.searchSource
            .size($scope.opts.size)
            .sort(getSort($scope.state.sort, $scope.indexPattern))
            .query(!$scope.state.query ? null : $scope.state.query)
            .set('filter', queryFilter.getFilters());
      });

      var init = _.once(function () {
        var showTotal = 5;
        $scope.failuresShown = showTotal;
        $scope.showAllFailures = function () {
          $scope.failuresShown = $scope.failures.length;
        };
        $scope.showLessFailures = function () {
          $scope.failuresShown = showTotal;
        };

        $scope.updateDataSource()
            .then(function () {
              $scope.$listen(timefilter, 'fetch', function () {
                $scope.fetch();
              });

              $scope.$watchCollection('state.sort', function (sort) {
                if (!sort) return;

                // get the current sort from {key: val} to ["key", "val"];
                var currentSort = _.pairs($scope.searchSource.get('sort')).pop();

                // if the searchSource doesn't know, tell it so
                if (!angular.equals(sort, currentSort)) $scope.fetch();
              });

              // update data source when filters update
              $scope.$listen(queryFilter, 'update', function () {
                return $scope.updateDataSource().then(function () {
                });
              });

              // update data source when hitting forward/back and the query changes
              $scope.$listen($scope.state, 'fetch_with_changes', function (diff) {
                if (diff.indexOf('query') >= 0) $scope.fetch();
              });

              // fetch data when filters fire fetch event
              $scope.$listen(queryFilter, 'fetch', $scope.fetch);

              $scope.$watch('opts.timefield', function (timefield) {
                timefilter.enabled = !!timefield;
              });

              $scope.$watch('state.interval', function (interval, oldInterval) {
                if (interval !== oldInterval && interval === 'auto') {
                  $scope.showInterval = false;
                }
                $scope.fetch();
              });

              $scope.$watch('vis.aggs', function () {
                // no timefield, no vis, nothing to update
                if (!$scope.opts.timefield) return;

                var buckets = $scope.vis.aggs.bySchemaGroup.buckets;

                if (buckets && buckets.length === 1) {
                  $scope.intervalName = 'by ' + buckets[0].buckets.getInterval().description;
                } else {
                  $scope.intervalName = 'auto';
                }
              });

              $scope.searchSource.onError(function (err) {
                notify.error(err);
              }).catch(notify.fatal);

              return Promise.resolve($scope.opts.timefield)
                  .then(function () {
                    init.complete = true;
                    $scope.state.replace();
                  });
            });
      });

      $scope.opts.fetch = $scope.fetch = function () {
        // ignore requests to fetch before the app inits
        if (!init.complete) return;

        $scope.updateTime();

        $scope.updateDataSource()
            .then(function () {
              return courier.fetch();
            })
            .catch(notify.error);
      };

      $scope.searchSource.onBeginSegmentedFetch(function (segmented) {
        function flushResponseData() {
          $scope.hits = 0;
          $scope.gravities = [];
        }

        /**
         * opts:
         *   "time" - sorted by the timefield
         *   "non-time" - explicitly sorted by a non-time field, NOT THE SAME AS `sortBy !== "time"`
         *   "implicit" - no sorting set, NOT THE SAME AS "non-time"
         *
         * @type {String}
         */
        var sortBy = (function () {
          if (!_.isArray($scope.opts.sort)) return 'implicit';
          else if ($scope.opts.sort[0] === '_score') return 'implicit';
          else if ($scope.opts.sort[0] === $scope.indexPattern.timeFieldName) return 'time';
          else return 'non-time';
        }());

        var sortFn = null;
        if (sortBy !== 'implicit') {
          sortFn = new HitSortFn($scope.opts.sort[1]);
        }

        if ($scope.opts.sort[0] === '_score') segmented.setMaxSegments(1);
        segmented.setDirection(sortBy === 'time' ? ($scope.opts.sort[1] || 'desc') : 'desc');
        segmented.setSortFn(sortFn);
        segmented.setSize($scope.opts.size);

        // triggered when the status updated
        segmented.on('status', function (status) {
          $scope.fetchStatus = status;
        });

        segmented.on('segment', notify.timed('handle each segment', function (segmentResp) {
          if (segmentResp._shards.failed > 0) {
            $scope.failures = _.union($scope.failures, segmentResp._shards.failures);
            $scope.failures = _.uniq($scope.failures, false, function (failure) {
              return failure.index + failure.shard + failure.reason;
            });
          }
        }));

        segmented.on('mergedSegment', function (resp) {
          $scope.hits = resp.hits.total;
          $scope.gravities = [];

          var rows = resp.hits.hits.slice();
          for (var i = 0; i < rows.length; i++) {
            var hit = rows[i];
            var gravity = gravityHelper.elasticHitToGravity(hit);
            $scope.gravities.push(gravity);
          }
        });

        segmented.on('complete', function () {
          if ($scope.fetchStatus.hitCount === 0) {
            flushResponseData();
          }

          $scope.fetchStatus = null;
        });
      }).catch(notify.fatal);

      $scope.updateTime = function () {
        $scope.timeRange = {
          from: dateMath.parse(timefilter.time.from),
          to: dateMath.parse(timefilter.time.to, true)
        };
      };

      init();
    });
  });
});
